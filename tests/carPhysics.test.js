import { describe, expect, it } from 'vitest';
import { CAR } from '../src/config.js';
import { createHeightField } from '../src/world/heightfield.js';
import { createTreeField } from '../src/game/treeField.js';
import { createCarState, resetCar, speedToKmh, stepCar } from '../src/car/carPhysics.js';

const SEED = 4242;
const DT = 1 / 60;

const NO_INPUT = { up: false, down: false, left: false, right: false };
const UP = { ...NO_INPUT, up: true };
const DOWN = { ...NO_INPUT, down: true };

/**
 * A flat, endless, waterless field.
 *
 * Behaviours like pedal priority and braking distances must be asserted without depending
 * on wherever the generated terrain happens to put a shoreline or a cliff.
 *
 * @returns {object} A minimal height field stand in.
 */
function createFlatField() {

	return {
		waterLevel: 0.05,
		heightAt() {

			return 0;

		},
		slopeAt() {

			return 0;

		},
		normalAt( x, z, out = { x: 0, y: 1, z: 0 } ) {

			out.x = 0;
			out.y = 1;
			out.z = 0;
			return out;

		},
		isLand() {

			return true;

		},
		waterDepthAt() {

			return 0;

		},
		findSpawnPoint() {

			return { x: 0, z: 0, height: 0, slope: 0 };

		},
	};

}

/**
 * A flat field that turns into sea beyond `shoreZ`.
 *
 * @param {number} shoreZ Where the beach ends.
 * @returns {object} Height field stand in.
 */
function createShoreField( shoreZ = 20 ) {

	const field = createFlatField();

	field.heightAt = ( x, z ) => ( z < shoreZ ? 10 : - 5 );
	field.isLand = ( x, z ) => field.heightAt( x, z ) > 0.6;
	field.waterDepthAt = ( x, z ) => 0.05 - field.heightAt( x, z );

	return field;

}

/**
 * A single ridge along the x axis, peaking at the origin, with a genuine kink at the top.
 *
 * The kink is the whole point. A fast car leaves the ground when the gradient under it
 * reverses discontinuously, which is exactly what the crests of the real terrain do: it is a
 * sum of dozens of overlapping hills plus noise, so it is full of slope reversals. A
 * perfectly smooth cosine crest contains no such reversal, and the physics correctly refuses
 * to launch off it however fast it is driven.
 *
 * Its grade is `height / radius` (~0.27, 15 degrees), and it falls to flat ground beyond
 * `+/- radius`.
 *
 * @param {number} [height] Peak height.
 * @param {number} [radius] Half width of the ridge.
 * @returns {object} Height field stand in.
 */
function createCrestField( height = 15, radius = 55 ) {

	const field = createFlatField();
	const grade = height / radius;

	field.heightAt = ( x, z ) => (
		Math.abs( z ) >= radius ? 0 : height * ( 1 - Math.abs( z ) / radius )
	);

	field.normalAt = ( x, z, out = { x: 0, y: 1, z: 0 } ) => {

		// Rising on the near side, falling on the far side.
		const gradient = Math.abs( z ) >= radius ? 0 : ( z > 0 ? - grade : grade );
		const length = Math.hypot( gradient, 1 );

		out.x = 0;
		out.y = 1 / length;
		out.z = - gradient / length;

		return out;

	};

	field.slopeAt = () => grade;

	return field;

}

/**
 * A car state placed on a field at a given spot.
 *
 * @param {object} field Height field.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {object} Car state.
 */
function stateAt( field, x, z ) {

	const state = createCarState( field );
	state.x = x;
	state.z = z;
	state.y = field.heightAt( x, z );
	state.groundY = state.y;
	state.lastSafe = { x, z, heading: 0 };

	return state;

}

/**
 * Runs the physics for a number of steps.
 *
 * @param {object} state Car state.
 * @param {object} input Held input.
 * @param {number} steps Number of 1/60 s steps.
 * @param {object} field Height field.
 * @param {object} [options] Step options (collision, config).
 * @returns {object} The state.
 */
function run( state, input, steps, field, options ) {

	for ( let i = 0; i < steps; i ++ ) stepCar( state, input, DT, field, options );

	return state;

}

/**
 * A collision world over a fixed set of trees, backed by the real spatial index.
 *
 * @param {Array<object>} trees Trees to index.
 * @returns {object} Collision registry that counts the trees it has broken.
 */
function createCollision( trees ) {

	const index = createTreeField( trees );
	const registry = {
		broken: 0,
		found: 0,
		queryNearby( x, z, radius, out ) {

			return index.queryNearby( x, z, radius, out );

		},
		breakTree( tree ) {

			if ( tree.alive === false ) return null;

			tree.alive = false;
			registry.broken ++;

			return { x: tree.x, z: tree.z, y: 0, radius: 1.5 };

		},
	};

	return registry;

}

/**
 * A tree standing in the path of a car that starts at the origin facing +z.
 *
 * @param {number} [distance] Distance from the origin.
 * @returns {object} Tree.
 */
function treeOnPath( distance = 30 ) {

	return { x: 0, z: distance, y: 0, index: 0, radius: 0.7, crownRadius: 1.5, alive: true };

}

/**
 * Islands the launch tuning is asserted against.
 *
 * These are the seeds from the sweep behind {@link CAR.launchGravity}. Seed 99 is the one
 * worth keeping: it was the island on which the car never left the ground at all before the
 * threshold was lowered, so it guards the regression that made the jumping useless.
 */
const ISLAND_SEEDS = [ 1, 3, 7, 11, 42, 99 ];

/**
 * Drives a fresh island at full throttle and reports its flight statistics.
 *
 * The run stops when the car reaches the sea: a car that has driven off the island is no
 * longer testing the terrain, and time spent floating would dilute every number.
 *
 * @param {number} seed Island seed.
 * @returns {{launches: number, longestFlight: number, airShare: number, frames: number}} Stats.
 */
function driveIsland( seed ) {

	const field = createHeightField( { seed } );
	const state = createCarState( field );

	let launches = 0;
	let longestFlight = 0;
	let airborne = 0;
	let current = 0;
	let frames = 0;

	while ( frames < 3600 ) {

		stepCar( state, UP, DT, field );

		if ( state.inWater || state.onLand === false ) break;

		frames ++;

		if ( state.airborne ) {

			airborne ++;
			current ++;

		} else {

			longestFlight = Math.max( longestFlight, current );
			current = 0;

		}

		for ( const event of state.events ) if ( event.type === 'launch' ) launches ++;

	}

	return {
		launches,
		longestFlight: Math.max( longestFlight, current ),
		airShare: airborne / Math.max( 1, frames ),
		frames,
	};

}

describe( 'car physics', () => {

	it( 'spawns on dry land, standing still', () => {

		const field = createHeightField( { seed: SEED } );
		const state = createCarState( field );

		expect( state.speed ).toBe( 0 );
		expect( state.airborne ).toBe( false );
		expect( field.isLand( state.x, state.z ) ).toBe( true );

	} );

	it( 'accelerates forward when ArrowUp is held', () => {

		const field = createHeightField( { seed: SEED } );
		const state = createCarState( field );
		const startX = state.x;
		const startZ = state.z;

		run( state, UP, 60, field );

		expect( state.speed ).toBeGreaterThan( 5 );
		expect( Math.hypot( state.x - startX, state.z - startZ ) ).toBeGreaterThan( 1 );

		// Forward is (sin heading, 0, cos heading): the move must follow the heading.
		const dx = state.x - startX;
		const dz = state.z - startZ;
		expect( dx * Math.sin( state.heading ) + dz * Math.cos( state.heading ) ).toBeGreaterThan( 0 );

	} );

	it( 'never exceeds the speed cap however long the throttle is held', () => {

		const field = createHeightField( { seed: SEED } );
		const state = createCarState( field );

		for ( let i = 0; i < 1200; i ++ ) {

			stepCar( state, UP, DT, field );
			expect( state.speed ).toBeLessThanOrEqual( CAR.maxSpeed + 1e-9 );

		}

	} );

	it( 'turns left on ArrowLeft and right on ArrowRight', () => {

		const leftField = createFlatField();
		const leftState = stateAt( leftField, 0, 0 );
		run( leftState, { ...NO_INPUT, up: true, left: true }, 90, leftField );

		const rightField = createFlatField();
		const rightState = stateAt( rightField, 0, 0 );
		run( rightState, { ...NO_INPUT, up: true, right: true }, 90, rightField );

		// The car's local +X is its left, so a left turn increases the heading.
		expect( leftState.heading ).toBeGreaterThan( 0 );
		expect( rightState.heading ).toBeLessThan( 0 );

	} );

	it( 'rolls to a halt when no key is pressed', () => {

		const field = createFlatField();
		const state = stateAt( field, 0, 0 );

		run( state, UP, 120, field );
		run( state, NO_INPUT, 900, field );

		expect( Math.abs( state.speed ) ).toBeLessThan( 0.05 );

	} );

	it( 'lets the throttle win when both pedals are held', () => {

		// Deliberate design choice: ArrowUp takes priority over ArrowDown.
		const field = createFlatField();
		const state = stateAt( field, 0, 0 );

		run( state, { ...NO_INPUT, up: true, down: true }, 120, field );

		expect( state.speed ).toBeCloseTo( CAR.accel * 2, 5 );

	} );

	it( 'brakes and then reverses on flat ground', () => {

		const field = createFlatField();
		const state = stateAt( field, 0, 0 );

		run( state, UP, 120, field );
		expect( state.speed ).toBeCloseTo( CAR.accel * 2, 5 );

		run( state, DOWN, 60, field );
		expect( Math.abs( state.speed ) ).toBeLessThan( 1.5 );

		run( state, DOWN, 120, field );
		expect( state.speed ).toBeLessThan( - 1 );

	} );

	it( 'resets onto a valid spawn point', () => {

		const field = createHeightField( { seed: SEED } );
		const state = createCarState( field );

		run( state, UP, 200, field );
		resetCar( state, field );

		expect( state.speed ).toBe( 0 );
		expect( state.airborne ).toBe( false );
		expect( field.isLand( state.x, state.z ) ).toBe( true );

	} );

	// --- vertical motion ---------------------------------------------------------------

	it( 'flies off a crest when driven fast over it', () => {

		const field = createCrestField();
		const state = stateAt( field, 0, - 55 );

		// Start it already at cruising speed, so this asserts the launch rule rather than how
		// quickly the car happens to accelerate up a particular hill.
		state.speed = 34;

		let sawAirborne = false;
		let sawLanding = false;
		let maxClearance = 0;

		for ( let i = 0; i < 900; i ++ ) {

			stepCar( state, UP, DT, field );

			const clearance = state.y - field.heightAt( state.x, state.z );

			if ( state.airborne ) {

				sawAirborne = true;
				maxClearance = Math.max( maxClearance, clearance );

			} else if ( sawAirborne ) {

				sawLanding = true;

			}

		}

		expect( sawAirborne ).toBe( true );
		expect( maxClearance ).toBeGreaterThan( 0.5 );
		expect( sawLanding ).toBe( true );
		expect( state.airborne ).toBe( false );

	} );

	it( 'does not fly at moderate speed over the same crest', () => {

		const field = createCrestField();
		const state = stateAt( field, 0, - 55 );
		state.speed = 16; // 58 km/h, well under the launch gate

		let sawAirborne = false;

		for ( let i = 0; i < 600; i ++ ) {

			stepCar( state, i % 4 === 0 ? UP : NO_INPUT, DT, field );
			if ( state.airborne ) sawAirborne = true;

		}

		expect( sawAirborne ).toBe( false );

	} );

	it( 'stays glued to the ground when creeping over the same crest', () => {

		const field = createCrestField();
		const state = stateAt( field, 0, - 90 );

		let sawAirborne = false;

		// A 1% duty cycle on the throttle keeps the car crawling along.
		for ( let i = 0; i < 3000; i ++ ) {

			stepCar( state, i % 100 === 0 ? UP : NO_INPUT, DT, field );
			if ( state.airborne ) sawAirborne = true;

		}

		expect( sawAirborne ).toBe( false );

	} );

	it( 'comes back down and keeps driving after a jump', () => {

		const field = createCrestField();
		const state = stateAt( field, 0, - 90 );

		run( state, UP, 900, field );

		expect( state.airborne ).toBe( false );
		expect( state.y ).toBeCloseTo( field.heightAt( state.x, state.z ), 6 );
		expect( state.speed ).toBeGreaterThan( 1 );

	} );

	it( 'emits launch and landing events with sane payloads', () => {

		const field = createCrestField();
		const state = stateAt( field, 0, - 90 );

		const launches = [];
		const landings = [];

		for ( let i = 0; i < 900; i ++ ) {

			stepCar( state, UP, DT, field );

			for ( const event of state.events ) {

				if ( event.type === 'launch' ) launches.push( event );
				if ( event.type === 'landing' ) landings.push( event );

			}

		}

		expect( launches.length ).toBeGreaterThan( 0 );
		expect( launches[ 0 ].speed ).toBeGreaterThan( 0 );
		expect( launches[ 0 ].speed ).toBeLessThanOrEqual( CAR.launchMaxSpeed );

		// Every launch must eventually be followed by a soft landing.
		expect( landings.length + launches.length ).toBeGreaterThan( 0 );

	} );

	// --- the sea ----------------------------------------------------------------------

	it( 'drives into the sea, then respawns back on land', () => {

		const field = createShoreField();
		const state = stateAt( field, 0, 0 );
		state.speed = 30;

		let sawWater = false;
		let sawRespawn = false;
		let landedOnLand = null;
		let input = UP;

		for ( let i = 0; i < 600; i ++ ) {

			stepCar( state, input, DT, field );

			if ( state.inWater ) sawWater = true;

			if ( state.events.some( ( event ) => event.type === 'respawn' ) ) {

				if ( sawRespawn === false ) landedOnLand = field.isLand( state.x, state.z );
				sawRespawn = true;

				// Stop driving straight back into the sea.
				input = NO_INPUT;

			}

		}

		expect( sawWater ).toBe( true );
		expect( sawRespawn ).toBe( true );
		expect( landedOnLand ).toBe( true );
		expect( state.inWater ).toBe( false );
		expect( field.isLand( state.x, state.z ) ).toBe( true );

	} );

	it( 'drags the car to a halt once it is in the water', () => {

		const field = createShoreField( - 10 );
		const state = stateAt( field, 0, 0 );
		state.speed = 30;

		// Half a second is well inside the respawn delay, so the car is still wet.
		run( state, NO_INPUT, 30, field );

		expect( state.inWater ).toBe( true );
		expect( Math.abs( state.speed ) ).toBeLessThan( 30 * 0.4 );

	} );

	it( 'converts speed to km/h', () => {

		expect( speedToKmh( 10 ) ).toBeCloseTo( 36, 6 );
		expect( speedToKmh( - 10 ) ).toBeCloseTo( 36, 6 );
		expect( speedToKmh( 0 ) ).toBe( 0 );

	} );

	// --- trees -------------------------------------------------------------------------

	it( 'smashes a tree when driving into it above 50 km/h', () => {

		const collision = createCollision( [ treeOnPath( 30 ) ] );
		const field = createFlatField();
		const state = stateAt( field, 0, 0 );
		state.speed = 60 / 3.6; // exactly 60 km/h

		let breakEvents = 0;

		for ( let i = 0; i < 240; i ++ ) {

			stepCar( state, UP, DT, field, { collision } );
			breakEvents += state.events.filter( ( event ) => event.type === 'treeBreak' ).length;

		}

		expect( breakEvents ).toBe( 1 );
		expect( collision.broken ).toBe( 1 );
		expect( state.blocked ).toBe( false );

		// Smashing it only scrubs a little speed, and the car drives straight through.
		expect( state.z ).toBeGreaterThan( 31 );

	} );

	it( 'is stopped by a tree when driving into it below 50 km/h', () => {

		const collision = createCollision( [ treeOnPath( 12 ) ] );
		const field = createFlatField();
		const state = stateAt( field, 0, 0 );
		state.speed = 40 / 3.6; // 40 km/h, coasting so it cannot accelerate past the limit

		let sawHit = false;

		for ( let i = 0; i < 240; i ++ ) {

			stepCar( state, NO_INPUT, DT, field, { collision } );
			if ( state.events.some( ( event ) => event.type === 'treeHit' ) ) sawHit = true;

		}

		expect( sawHit ).toBe( true );
		expect( collision.broken ).toBe( 0 );
		expect( state.blocked ).toBe( true );

		// The car comes to rest on the near side of the trunk.
		const stopDistance = CAR.carRadius + CAR.treeRadius;
		expect( state.z ).toBeLessThan( 12 - stopDistance + 0.2 );

	} );

	it( 'never touches a tree it does not drive into', () => {

		const collision = createCollision( [ { ...treeOnPath( 30 ), x: 12 } ] );
		const field = createFlatField();
		const state = stateAt( field, 0, 0 );
		state.speed = 70 / 3.6;

		run( state, UP, 240, field, { collision } );

		expect( collision.broken ).toBe( 0 );
		expect( state.z ).toBeGreaterThan( 30 );

	} );

	// The launch tuning (see CAR.launchGravity / CAR.airGravity) was swept across seeds, and
	// these tests pin the two failure modes that sweep turned up: an island on which the car
	// never flies at all, and a jump that turns into a multi-second glide.
	it( 'launches the car on a full throttle run over every island', () => {

		for ( const seed of ISLAND_SEEDS ) {

			const { launches } = driveIsland( seed );

			expect( launches, `seed ${ seed } never launched the car` ).toBeGreaterThan( 4 );

		}

	} );

	it( 'keeps every flight short, and the car mostly on the ground', () => {

		for ( const seed of ISLAND_SEEDS ) {

			const { longestFlight, airShare } = driveIsland( seed );

			expect( longestFlight, `seed ${ seed } glided for ${ longestFlight } frames` ).toBeLessThan( 80 );
			expect( airShare, `seed ${ seed } was airborne for ${ Math.round( airShare * 100 ) }%` ).toBeLessThan( 0.4 );

		}

	} );

	it( 'comes back down onto its wheels after flying', () => {

		for ( const seed of ISLAND_SEEDS ) {

			const field = createHeightField( { seed } );
			const state = createCarState( field );

			let sawFlight = false;

			for ( let i = 0; i < 1800 && sawFlight === false; i ++ ) {

				stepCar( state, UP, DT, field );
				if ( state.airborne ) sawFlight = true;
				if ( state.inWater ) break;

			}

			// Coast for three seconds: a car still in the air after that has not landed.
			run( state, NO_INPUT, 180, field );

			expect( state.airborne, `seed ${ seed } was still airborne after coasting` ).toBe( false );

		}

	} );

} );