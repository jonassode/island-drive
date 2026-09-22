/**
 * Arcade car physics.
 *
 * A bicycle model driven by four booleans: no physics engine, no DOM, no meshes. That
 * keeps it fast, predictable and unit testable in Node.
 *
 * Everything below is pure simulation. World mutation (breaking a tree, respawning) is
 * reported through `state.events` so the caller can play effects; the only thing the
 * simulation calls out to is the collision registry it is handed.
 *
 * Sign conventions (asserted by the tests in tests/carPhysics.test.js):
 * - `heading` rotates about +Y and the car's forward axis is `(sin, 0, cos)`.
 * - The car's local +X is its **left** side, so steering left means a positive
 *   `steerAngle`, which makes `heading` increase.
 *
 * Event types emitted on `state.events`:
 * - `launch`     `{ speed }`   the car left the ground over a crest.
 * - `landing`    `{ impact }`  it came back down hard.
 * - `treeBreak`  `{ x, z, y, radius }` a tree was smashed.
 * - `treeHit`    `{}`          the car was stopped by a tree.
 * - `water`      `{ depth }`   the car entered the sea for the first time.
 * - `respawn`    `{}`          the car was put back on dry land.
 */

import { CAR } from '../config.js';

/** Scratch normal, reused every step so the update allocates nothing. */
const normal = { x: 0, y: 1, z: 0 };
/** Trees found near the car, reused every step. */
const nearbyTrees = [];
/** Stand-in collision world, used by terrain with no obstacles (and by the tests). */
const NO_COLLISION = {
	queryNearby() {

		return 0;

	},
	breakTree() {

		return null;

	},
};
/** Weight of the newest sample when smoothing the terrain's vertical velocity. */
const GROUND_SPEED_SMOOTHING = 0.35;

/**
 * Clamps a value into a range.
 *
 * @param {number} value Value.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @returns {number} The clamped value.
 */
function clamp( value, min, max ) {

	return Math.min( max, Math.max( min, value ) );

}

/**
 * Builds a car state from a spawn point.
 *
 * @param {object} heightField Terrain to sample.
 * @param {object} spawn Spawn point, as returned by `findSpawnPoint()`.
 * @returns {object} A fresh car state.
 */
function stateFromSpawn( heightField, spawn ) {

	const y = heightField.heightAt( spawn.x, spawn.z );

	return {
		x: spawn.x,
		z: spawn.z,
		y,
		heading: 0,
		speed: 0,
		steerAngle: 0,
		verticalSpeed: 0,
		groundSpeed: 0,
		groundY: y,
		airborne: false,
		inWater: false,
		waterTime: 0,
		onLand: true,
		bumped: false,
		blocked: false,
		slopeAccel: 0,
		safeTimer: 0,
		events: [],
		spawn,
		lastSafe: { x: spawn.x, z: spawn.z, heading: 0 },
	};

}

/**
 * Creates a car state at the height field's recommended spawn point.
 *
 * @param {object} heightField The terrain the car will drive on.
 * @returns {object} A fresh car state.
 */
export function createCarState( heightField ) {

	return stateFromSpawn( heightField, heightField.findSpawnPoint() );

}

/**
 * Puts the car back on a valid spawn point, standing still.
 *
 * @param {object} state Car state to mutate.
 * @param {object} heightField The terrain to spawn on.
 * @returns {object} The same state object.
 */
export function resetCar( state, heightField ) {

	const spawn = heightField.findSpawnPoint();
	state.spawn = spawn;

	return placeAt( state, heightField, spawn.x, spawn.z, 0 );

}

/**
 * Places the car on a spot, stationary and grounded.
 *
 * @param {object} state Car state to mutate.
 * @param {object} heightField Terrain to sample.
 * @param {number} x World x.
 * @param {number} z World z.
 * @param {number} heading New heading.
 * @returns {object} The same state object.
 */
function placeAt( state, heightField, x, z, heading ) {

	const y = heightField.heightAt( x, z );

	state.x = x;
	state.z = z;
	state.y = y;
	state.heading = heading;
	state.speed = 0;
	state.steerAngle = 0;
	state.verticalSpeed = 0;
	state.groundSpeed = 0;
	state.groundY = y;
	state.airborne = false;
	state.inWater = false;
	state.waterTime = 0;
	state.onLand = true;
	state.bumped = false;
	state.blocked = false;
	state.slopeAccel = 0;
	state.lastSafe.x = x;
	state.lastSafe.z = z;
	state.lastSafe.heading = heading;

	return state;

}

/**
 * Resolves tree collisions along the path the car just travelled.
 *
 * The path is treated as a capsule: any living tree whose trunk is closer than
 * `carRadius + treeRadius` to the segment is a hit. Above `breakSpeedKmh` the tree is
 * smashed and the car keeps going, losing a little speed per tree; below it the tree wins
 * and the car is stopped, which is what makes a dense clump read as a wall.
 *
 * @param {object} state Car state, mutated with the outcome.
 * @param {number} startX Path start x.
 * @param {number} startZ Path start z.
 * @param {number} endX Path end x.
 * @param {number} endZ Path end z.
 * @param {object} collision Collision registry.
 * @param {object} config Vehicle tunables.
 * @returns {boolean} True when the car was stopped by a tree.
 */
function resolveTrees( state, startX, startZ, endX, endZ, collision, config ) {

	const segmentX = endX - startX;
	const segmentZ = endZ - startZ;
	const segmentLength = Math.hypot( segmentX, segmentZ );

	if ( segmentLength < 1e-6 ) return false;

	const reach = config.carRadius + config.treeRadius;
	const found = collision.queryNearby(
		( startX + endX ) / 2,
		( startZ + endZ ) / 2,
		segmentLength / 2 + reach,
		nearbyTrees,
	);

	for ( let i = 0; i < found; i ++ ) {

		const tree = nearbyTrees[ i ];

		// Closest point on the travelled segment to this trunk.
		const toTreeX = tree.x - startX;
		const toTreeZ = tree.z - startZ;
		const t = clamp( ( toTreeX * segmentX + toTreeZ * segmentZ ) / ( segmentLength * segmentLength ), 0, 1 );

		const closestX = startX + segmentX * t;
		const closestZ = startZ + segmentZ * t;

		if ( Math.hypot( tree.x - closestX, tree.z - closestZ ) > reach ) continue;

		const speedKmh = Math.abs( state.speed ) * 3.6;

		if ( speedKmh > config.breakSpeedKmh ) {

			const debris = collision.breakTree( tree );

			if ( debris !== null ) {

				state.speed *= config.breakSlowdown;
				state.events.push( { type: 'treeBreak', ...debris } );

			}

		} else {

			state.bumped = true;
			state.blocked = true;
			state.speed *= config.blockBounce;
			state.events.push( { type: 'treeHit' } );

			return true;

		}

	}

	return false;

}

/**
 * Advances the car by one time step.
 *
 * @param {object} state Car state, mutated in place.
 * @param {{up: boolean, down: boolean, left: boolean, right: boolean}} input Current input.
 * @param {number} dt Time step in seconds (already clamped by the caller).
 * @param {object} heightField The terrain to sample.
 * @param {object} [options] Hooks.
 * @param {object} [options.config] Vehicle tunables.
 * @param {object} [options.collision] Obstacle registry; omit for a clear world.
 * @returns {object} The same state object.
 */
export function stepCar( state, input, dt, heightField, options = {} ) {

	const config = options.config ?? CAR;
	const collision = options.collision ?? NO_COLLISION;

	state.events.length = 0;
	state.bumped = false;

	// 1. Longitudinal forces. There is no engine grip in mid air, and the sea drags the car
	//    to a halt exponentially.
	if ( state.inWater ) {

		state.speed *= Math.max( 0, 1 - config.waterDrag * dt );

	} else if ( state.airborne === false ) {

		if ( input.up ) {

			state.speed += config.accel * dt;

		} else if ( input.down ) {

			if ( state.speed > 0.5 ) {

				state.speed -= config.brake * dt;

			} else {

				state.speed = Math.max( state.speed - config.accel * 0.6 * dt, - config.maxReverse );

			}

		} else {

			const resistance = config.drag * dt;
			state.speed -= Math.sign( state.speed ) * Math.min( Math.abs( state.speed ), resistance );
			if ( Math.abs( state.speed ) < 1e-3 ) state.speed = 0;

		}

	}

	// 2. Vertical motion. On the ground the car follows the terrain and can be launched off
	//    a crest; in the air it is a plain projectile.
	const groundY = heightField.heightAt( state.x, state.z );

	if ( state.airborne ) {

		state.verticalSpeed -= config.airGravity * dt;
		state.y += state.verticalSpeed * dt;

		if ( state.y <= groundY ) {

			const impact = Math.max( 0, - state.verticalSpeed );

			state.airborne = false;
			state.y = groundY;
			state.verticalSpeed = 0;
			state.groundSpeed = 0;

			if ( impact > config.landingImpactSpeed ) {

				state.speed *= config.landingDamping;
				state.events.push( { type: 'landing', impact } );

			}

		}

		// Keep tracking the ground below, so landing cannot be fooled by stale data.
		state.groundY = groundY;

	} else {

		// Slope: gravity projected onto the locally planar ground slows the car uphill and
		// speeds it up downhill.
		const surface = heightField.normalAt( state.x, state.z, normal );
		const forwardX = Math.sin( state.heading );
		const forwardZ = Math.cos( state.heading );
		const along = surface.x * forwardX + surface.z * forwardZ;
		const forwardY = - surface.y * along;

		state.slopeAccel = - config.gravity * forwardY;
		state.speed += state.slopeAccel * dt;

		// The terrain's own vertical velocity under the car, smoothed so that single frame
		// noise cannot trigger a jump.
		const terrainRise = ( groundY - state.groundY ) / dt;
		const smoothed = state.groundSpeed + ( terrainRise - state.groundSpeed ) * GROUND_SPEED_SMOOTHING;
		const acceleration = ( smoothed - state.groundSpeed ) / dt;

		// Two conditions: the ground has to curve away faster than the launch threshold (so
		// the car physically cannot stay in contact over a crest), and the car has to be
		// going fast enough for it to matter. Creeping over the same hill never lifts it.
		const fallingAway = acceleration < - config.launchGravity;
		const fastEnough = Math.abs( state.speed ) > config.launchMinSpeed;

		if ( fallingAway && fastEnough ) {

			// Carry whatever climb rate the car had; crossing the very top of a crest means
			// that is zero, which still gives a long, readable flight.
			state.airborne = true;
			state.verticalSpeed = clamp( smoothed, 0, config.launchMaxSpeed );
			state.events.push( { type: 'launch', speed: state.verticalSpeed } );

		} else {

			state.groundSpeed = smoothed;
			state.y = groundY;
			state.verticalSpeed = 0;

		}

		state.groundY = groundY;

	}

	// 3. Yaw from the bicycle model; authority drops off with speed so the car does not spin
	//    instantly at top speed, and steering is nearly useless in mid air. The clamp is
	//    written back so the speed can never creep past its cap via the accelerations above.
	const speed = clamp( state.speed, - config.maxReverse, config.maxSpeed );
	state.speed = speed;

	const authority = 1 / ( 1 + Math.abs( speed ) * config.steerFalloff );
	const grip = state.airborne ? config.airSteerAuthority : 1;
	const yawRate = ( speed / config.wheelBase ) * Math.tan( state.steerAngle ) * authority * grip;

	state.heading += yawRate * dt;

	// 4. Integrate, resolving trees along the way.
	const startX = state.x;
	const startZ = state.z;
	const nextX = startX + Math.sin( state.heading ) * speed * dt;
	const nextZ = startZ + Math.cos( state.heading ) * speed * dt;

	const stopped = resolveTrees( state, startX, startZ, nextX, nextZ, collision, config );

	if ( stopped === false ) {

		state.x = nextX;
		state.z = nextZ;

	}

	// 5. The sea: driving in is allowed, so it looks like driving in, but the water drags the
	//    car to a stop and then puts it back on dry land.
	const depth = heightField.waterDepthAt !== undefined
		? heightField.waterDepthAt( state.x, state.z )
		: 0;

	if ( depth > 0 ) {

		if ( state.inWater === false ) state.events.push( { type: 'water', depth } );

		state.inWater = true;
		state.airborne = false;
		state.verticalSpeed = 0;
		state.groundSpeed = 0;
		state.waterTime += dt;

		// Partly submerged, unless the water is shallow enough under the wheels.
		state.y = Math.max( groundY, heightField.waterLevel - config.waterSink );

		if ( state.waterTime >= config.waterRespawnDelay ) {

			const safe = state.lastSafe;
			placeAt( state, heightField, safe.x, safe.z, safe.heading );
			state.events.push( { type: 'respawn' } );

		}

	} else {

		state.inWater = false;
		state.waterTime = 0;

	}

	state.onLand = heightField.isLand( state.x, state.z );

	// 6. Remember somewhere safe to respawn from: flat, dry, and only every so often, so the
	//    car is never sent back further than it needs to be.
	state.safeTimer += dt;

	const settled = state.onLand && state.inWater === false && state.airborne === false;

	if ( settled && state.safeTimer > 0.4 ) {

		state.safeTimer = 0;

		const slope = heightField.slopeAt !== undefined ? heightField.slopeAt( state.x, state.z ) : 0;

		if ( slope < 0.25 ) {

			state.lastSafe.x = state.x;
			state.lastSafe.z = state.z;
			state.lastSafe.heading = state.heading;

		}

	}

	// 7. Steering angle approaches its target at a fixed rate.
	const target = ( input.left ? config.maxSteer : 0 ) + ( input.right ? - config.maxSteer : 0 );
	const delta = target - state.steerAngle;
	const maxDelta = config.steerRate * dt;
	state.steerAngle += Math.sign( delta ) * Math.min( Math.abs( delta ), maxDelta );

	return state;

}

/**
 * Converts a speed in world units per second to km/h for the HUD.
 *
 * @param {number} speed Speed in units per second.
 * @returns {number} Speed in km/h.
 */
export function speedToKmh( speed ) {

	return Math.abs( speed ) * 3.6;

}
