/**
 * Bootstrap and game loop.
 *
 * Responsibilities: create the renderer/scene once, (re)build the island for a seed, place
 * the car on it, and run the fixed-order update pipeline:
 * input -> physics -> car mesh -> camera -> world animation -> render.
 */

import {
	ACESFilmicToneMapping, Clock, PCFSoftShadowMap, PerspectiveCamera, Quaternion,
	Raycaster, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';

import { CAMERA, CAR, WORLD } from './config.js';
import { createInput } from './input.js';
import { createHud } from './hud.js';
import { createChaseCamera } from './camera.js';
import { randomSeed } from './world/rng.js';
import { createHeightField } from './world/heightfield.js';
import { createIsland } from './world/island.js';
import { createWater } from './world/water.js';
import { createSky } from './world/sky.js';
import { createProps } from './world/props.js';
import { createTreeField } from './game/treeField.js';
import { buildCar } from './car/carModel.js';
import { createDebris } from './car/carDebris.js';
import { createCarState, resetCar, speedToKmh, stepCar } from './car/carPhysics.js';

/** Longest time step the simulation will accept, so tab switches cannot teleport the car. */
const MAX_STEP = 1 / 30;

// ---------------------------------------------------------------- renderer & scene

const canvas = document.getElementById( 'game' );
const renderer = new WebGLRenderer( { canvas, antialias: true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.setSize( window.innerWidth, window.innerHeight, false );
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;

const scene = new Scene();
const camera = new PerspectiveCamera(
	CAMERA.fov,
	window.innerWidth / window.innerHeight,
	CAMERA.near,
	CAMERA.far,
);

const clock = new Clock();
const hud = createHud();
const input = createInput();

// The sky, the sun and the ocean are identical on every island, so they are created once.
const sky = createSky( scene, renderer, WORLD );
const water = createWater( WORLD );
scene.add( water.group );

// ---------------------------------------------------------------- world & car state

let field = null;
let island = null;
let props = null;
let trees = null;
let collision = null;
let chase = null;
let carState = null;
let elapsed = 0;
let hudReady = false;

const car = buildCar();
scene.add( car.group );

const debris = createDebris();
scene.add( debris.group );

// Scratch objects, so the per-frame transform maths allocates nothing.
const UP = new Vector3( 0, 1, 0 );
const DOWN = new Vector3( 0, - 1, 0 );
const normalScratch = new Vector3();
const yawQuat = new Quaternion();
const tiltQuat = new Quaternion();
const rayOrigin = new Vector3();
const groundRay = new Raycaster();
const wheelHeights = new Float32Array( 4 );
const MAX_TILT_COS = Math.cos( CAR.maxTilt );

/**
 * Casts a ray straight down onto the rendered terrain mesh.
 *
 * Used by the smoke test to prove the car really rests on the *rendered* surface, not just
 * on the height field it was generated from.
 *
 * @param {number} [offsetX] Offset from the car in world units.
 * @param {number} [offsetZ] Offset from the car in world units.
 * @returns {number|null} World height of the terrain under that point, if any.
 */
function probeGround( offsetX = 0, offsetZ = 0 ) {

	const from = Math.max( carState.y, field.heightAt( carState.x + offsetX, carState.z + offsetZ ) ) + 20;

	rayOrigin.set( carState.x + offsetX, from, carState.z + offsetZ );
	groundRay.set( rayOrigin, DOWN );
	groundRay.far = 60;

	const hits = groundRay.intersectObject( island.mesh, false );

	return hits.length > 0 ? hits[ 0 ].point.y : null;

}

/**
 * Reads the seed from `?seed=`, falling back to a fresh random one.
 *
 * @returns {number} The seed for this page load.
 */
function readSeed() {

	const raw = new URLSearchParams( location.search ).get( 'seed' );

	if ( raw !== null ) {

		const parsed = Number.parseInt( raw, 10 );
		if ( Number.isFinite( parsed ) ) return Math.abs( parsed );

	}

	return randomSeed( WORLD.maxSeed );

}

/**
 * Mirrors the active seed into the address bar so an island can be shared or reloaded.
 *
 * @param {number} seed Active seed.
 * @returns {void}
 */
function writeSeedToUrl( seed ) {

	if ( typeof history === 'undefined' ) return;
	history.replaceState( null, '', `${location.pathname}?seed=${seed}` );

}

/** Releases the GPU resources of the current island. */
function disposeWorld() {

	if ( island !== null ) {

		scene.remove( island.group );
		island.dispose();
		island = null;

	}

	if ( props !== null ) {

		scene.remove( props.group );
		props.dispose();
		props = null;

	}

	trees = null;
	collision = null;

}

/**
 * Generates a brand new island from a seed.
 *
 * @param {number} seed Seed of the island to generate.
 * @returns {void}
 */
function buildIsland( seed ) {

	disposeWorld();

	field = createHeightField( { seed } );
	island = createIsland( field, { size: WORLD.size, segments: WORLD.segments } );
	props = createProps( field );

	scene.add( island.group );
	scene.add( props.group );

	// The car's collision world: the spatial index answers "what is near me?", and the props
	// module owns the actual removal when something gets smashed.
	trees = createTreeField( props.trees, { cellSize: 60 } );
	collision = {
		queryNearby( x, z, radius, out ) {

			return trees.queryNearby( x, z, radius, out );

		},
		breakTree( tree ) {

			return props.breakTree( tree );

		},
	};

	chase = createChaseCamera( camera, field );

	hud.setSeed( seed );
	writeSeedToUrl( seed );

}

/**
 * Places (or re-places) the car on the current island.
 *
 * @returns {void}
 */
function spawnCar() {

	if ( carState === null ) {

		carState = createCarState( field );

	} else {

		resetCar( carState, field );

	}

	updateCarMesh( 0 );
	chase.snap();

}

/**
 * Copies the physics state onto the car meshes.
 *
 * On the ground, the height and the tilt are fitted to the terrain sampled under all four
 * wheels rather than a single centre sample. A rigid body has no suspension, so without
 * this the car visibly hovers over bumps and digs into dips. In the air the body simply
 * follows the simulated height and levellers off, which is what makes a jump readable.
 *
 * @param {number} dt Time step, used for the wheel roll rate.
 * @returns {void}
 */
function updateCarMesh( dt ) {

	const heading = carState.heading;
	const forwardX = Math.sin( heading );
	const forwardZ = Math.cos( heading );
	// The car's local +X is its left side.
	const leftX = Math.cos( heading );
	const leftZ = - Math.sin( heading );

	const offsets = car.wheelOffsets;
	const heights = wheelHeights;

	let total = 0;

	for ( let i = 0; i < offsets.length; i ++ ) {

		const offset = offsets[ i ];
		const worldX = carState.x + offset.x * leftX + offset.z * forwardX;
		const worldZ = carState.z + offset.x * leftZ + offset.z * forwardZ;
		const height = field.heightAt( worldX, worldZ );

		heights[ i ] = height;
		total += height;

	}

	// Offsets are ordered front-left, front-right, rear-left, rear-right.
	const centreY = total / offsets.length;
	const front = ( heights[ 0 ] + heights[ 1 ] ) / 2;
	const rear = ( heights[ 2 ] + heights[ 3 ] ) / 2;
	const left = ( heights[ 0 ] + heights[ 2 ] ) / 2;
	const right = ( heights[ 1 ] + heights[ 3 ] ) / 2;

	// On the ground follow the terrain under the wheels; in the air follow the simulation,
	// which is what lets the car fly over a crest instead of being glued to it.
	car.group.position.set( carState.x, carState.y + CAR.rideHeight, carState.z );

	// Height gradients along the car's own axes, converted into a world surface normal.
	const track = Math.abs( offsets[ 0 ].x - offsets[ 1 ].x ) || 1;
	const base = Math.abs( offsets[ 0 ].z - offsets[ 2 ].z ) || 1;
	const gradeForward = ( front - rear ) / base;
	const gradeLeft = ( left - right ) / track;

	const gx = gradeForward * forwardX + gradeLeft * leftX;
	const gz = gradeForward * forwardZ + gradeLeft * leftZ;

	if ( carState.airborne ) {

		// Ease towards level while flying, so a jump ends with the wheels pointing down.
		const level = Math.min( 1, CAR.airLevelRate * dt );
		normalScratch.lerp( UP, level ).normalize();

	} else {

		normalScratch.set( - gx, 1, - gz ).normalize();

		// Clamp how far the car may lean, so a cliff edge can never roll it over.
		if ( normalScratch.y < MAX_TILT_COS ) {

			const t = ( 1 - MAX_TILT_COS ) / ( 1 - normalScratch.y );
			normalScratch.x *= t;
			normalScratch.z *= t;
			normalScratch.y = 1 - t + t * normalScratch.y;
			normalScratch.normalize();

		}

	}

	tiltQuat.setFromUnitVectors( UP, normalScratch );
	yawQuat.setFromAxisAngle( UP, heading );
	car.group.quaternion.multiplyQuaternions( tiltQuat, yawQuat );

	// Visual suspension: the body keeps the fitted plane, and each wheel reaches for the
	// ground under it, so bumps do not leave wheels hanging in the air.
	for ( let i = 0; i < offsets.length; i ++ ) {

		const offset = offsets[ i ];
		const node = car.suspension[ i ];

		if ( carState.airborne || carState.inWater ) {

			// Nothing to reach for: let the wheels hang at full droop.
			node.node.position.y = node.baseY - CAR.suspensionTravel;

		} else {

			const planeHeight = centreY + gradeForward * offset.z + gradeLeft * offset.x;

			let travel = heights[ i ] - planeHeight;
			travel = Math.max( - CAR.suspensionTravel, Math.min( CAR.suspensionTravel, travel ) );

			node.node.position.y = node.baseY + travel;

		}

	}

	const roll = dt * ( carState.speed / CAR.wheelRadius );
	for ( const wheel of car.wheels ) wheel.rotation.x += roll;
	for ( const pivot of car.steerPivots ) pivot.rotation.y = carState.steerAngle;

}

/** Resets the car onto a valid spawn point. */
function respawnCar() {

	resetCar( carState, field );
	updateCarMesh( 0 );
	chase.snap();

}

/** Generates a different island and drives the car onto it. */
function regenerateIsland() {

	buildIsland( randomSeed( WORLD.maxSeed ) );
	spawnCar();

}

// ---------------------------------------------------------------- loop & lifecycle

/** Status line shown by the HUD, and how long it stays up. */
let statusText = '';
let statusTimer = 0;

/**
 * Reacts to what happened during the physics step: spawns debris and posts HUD messages.
 *
 * @param {number} dt Time step, so messages can expire.
 * @returns {void}
 */
function handleEvents( dt ) {

	for ( const event of carState.events ) {

		if ( event.type === 'treeBreak' ) {

			debris.burst( event, Math.sin( carState.heading ) * carState.speed, Math.cos( carState.heading ) * carState.speed );
			statusText = 'tree smashed!';
			statusTimer = 1.6;

		} else if ( event.type === 'treeHit' ) {

			statusText = 'blocked — you need more than 50 km/h to smash a tree';
			statusTimer = 2.4;

		} else if ( event.type === 'water' ) {

			statusText = 'water! respawning…';
			statusTimer = 2;

		} else if ( event.type === 'respawn' ) {

			statusText = 'back on dry land';
			statusTimer = 2;

		} else if ( event.type === 'launch' ) {

			statusText = 'airborne!';
			statusTimer = 1.2;

		}

	}

	if ( statusTimer > 0 ) {

		statusTimer -= dt;
		if ( statusTimer <= 0 ) statusText = '';

	}

	hud.setStatus( statusText );

}

/**
 * One simulation + render step.
 *
 * @returns {void}
 */
function frame() {

	const dt = Math.min( clock.getDelta(), MAX_STEP );
	elapsed += dt;

	stepCar( carState, input, dt, field, { collision } );
	updateCarMesh( dt );
	chase.update( dt, carState, car.group );

	debris.update( dt );
	handleEvents( dt );

	water.update( elapsed );
	sky.update( elapsed );

	// The shadow map only covers the area around the car, so it has to follow it.
	sky.focusShadow( carState.x, carState.z );

	hud.setSpeed( speedToKmh( carState.speed ) );
	hud.setAirborne( carState.airborne );

	renderer.render( scene, camera );

	if ( hudReady === false ) {

		hudReady = true;
		hud.setReady();

	}

}

/** Keeps the drawing buffer and camera in sync with the window. */
function handleResize() {

	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
	renderer.setSize( window.innerWidth, window.innerHeight, false );

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();

}

window.addEventListener( 'resize', handleResize );

// A background tab stops producing frames; drop the accumulated time on return.
document.addEventListener( 'visibilitychange', () => {

	if ( document.hidden === false ) clock.getDelta();

} );

input.onRegenerate( regenerateIsland );
input.onRespawn( respawnCar );

// ---------------------------------------------------------------- start

buildIsland( readSeed() );
spawnCar();
handleResize();
renderer.setAnimationLoop( frame );

// Small debug surface: lets the console (or a smoke test) inspect and drive the game.
window.__carGame = {
	renderer,
	scene,
	camera,
	car,
	input,
	probeGround,
	regenerateIsland,
	respawnCar,
	step( dt = MAX_STEP, overrideInput = input ) {

		stepCar( carState, overrideInput, dt, field, { collision } );
		updateCarMesh( dt );
		// Faithful to the real loop: events spawn debris and update the status line.
		handleEvents( 0 );

	},
	get state() {

		return carState;

	},
	get field() {

		return field;

	},
	get props() {

		return props;

	},
	get debris() {

		return debris;

	},
	get collision() {

		return collision;

	},
};

