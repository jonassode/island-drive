/**
 * Bootstrap and game loop.
 *
 * Responsibilities: create the renderer/scene once, (re)build the island for a seed, place the
 * car on it, and run the fixed-order update pipeline:
 * input -> physics -> car mesh -> camera -> world animation -> render.
 *
 * Multiplayer is layered on top rather than woven through: the physics runs at a fixed
 * `MULTIPLAYER.tickRate` so the server's result can be replayed exactly, the local car is
 * predicted and reconciled by `src/multiplayer/prediction.js`, and other players' cars are
 * interpolated by `src/multiplayer/remoteCars.js`. If the socket never connects — a static
 * deployment, `?solo=1`, or simply no server — every one of those layers is inert and the game
 * is the single player game it always was.
 */

import {
	ACESFilmicToneMapping, Clock, PCFSoftShadowMap, PerspectiveCamera,
	Raycaster, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';

import { CAMERA, MULTIPLAYER, WORLD } from './config.js';
import { createInput } from './input.js';
import { createHud } from './hud.js';
import { createChaseCamera } from './camera.js';
import { randomSeed } from './world/rng.js';
import { createHeightField } from './world/heightfield.js';
import { createIsland } from './world/island.js';
import { createPathField } from './world/pathField.js';
import { createPath } from './world/path.js';
import { createWater } from './world/water.js';
import { createSky } from './world/sky.js';
import { createProps } from './world/props.js';
import { createTreeField } from './game/treeField.js';
import { buildCar } from './car/carModel.js';
import { createCarTransform } from './car/carTransform.js';
import { createDebris } from './car/carDebris.js';
import { fitCarToGround } from './car/carPose.js';
import { createCarState, resetCar, speedToKmh, stepCar } from './car/carPhysics.js';
import { createNet, STATUS } from './multiplayer/net.js';
import { createPrediction } from './multiplayer/prediction.js';
import { createRemoteCars } from './multiplayer/remoteCars.js';
import * as protocol from './multiplayer/protocol.js';

/** Longest time step the simulation will accept, so tab switches cannot teleport the car. */
const MAX_STEP = 1 / 30;
/** Fixed simulation step, matching the server's default. The server may override it. */
const DEFAULT_STEP = 1 / MULTIPLAYER.tickRate;
/** Ceiling on catch-up steps in one frame, so a stalled tab cannot spiral. */
const MAX_STEPS_PER_FRAME = 5;

// ---------------------------------------------------------------- page parameters

const params = new URLSearchParams( location.search );

/**
 * The room to join.
 *
 * An explicit `?room=` wins. An explicit `?seed=` and nothing else means "join the island with
 * this seed", which is what makes a shared `?seed=` link put two people on the same island —
 * and what keeps `?seed=1` and `?seed=2` from meeting. With neither, everyone lands in the one
 * default room.
 *
 * @returns {string} Room id.
 */
function readRoom() {

	const room = params.get( 'room' );
	if ( room !== null && room !== '' ) return room;

	const seed = params.get( 'seed' );
	if ( seed !== null && seed !== '' ) return `seed-${seed}`;

	return MULTIPLAYER.room;

}

/** `?solo=1` keeps the socket closed, for a deliberate single player game. */
const solo = params.get( 'solo' ) === '1';
const room = readRoom();

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
let pathField = null;
let path = null;
let trees = null;
let collision = null;
/** The registry the *local* car resolves trees against; see `refreshLocalCollision()`. */
let localCollision = null;
let chase = null;
let carState = null;
let elapsed = 0;
let hudReady = false;

/**
 * Live accessors for the current island.
 *
 * The multiplayer layers outlive any single island, so they are handed these rather than a
 * snapshot of `field`/`props`, which are replaced on every regeneration.
 */
const world = {
	get field() {

		return field;

	},
	get props() {

		return props;

	},
};

const car = buildCar();
scene.add( car.group );
/** Poses the local car from its physics state; every remote car gets its own. */
const carTransform = createCarTransform( car );

const debris = createDebris();
scene.add( debris.group );

// ---------------------------------------------------------------- multiplayer layer

/** The local car's prediction: input history, rollback, and the smoothed correction. */
const prediction = createPrediction();
/** Other players' cars, drawn from the snapshot stream. */
const remoteCars = createRemoteCars( { scene, world, debris } );

/** The room's players, as last told to us by the server. */
let roster = [];
let selfId = 0;
let roomName = '';
/** Whether the socket is live, i.e. whether the server is authoritative for our car. */
let online = false;
/** Ticks since the last input batch was sent. */
let ticksSinceSend = 0;
/**
 * The fixed step this client simulates at.
 *
 * Taken from the server's `welcome` rather than assumed: a client predicting at a different
 * rate than the server simulates is a client that is permanently, quietly wrong.
 */
let tickStep = DEFAULT_STEP;

/** The socket, or null when this page deliberately plays alone. */
const net = solo ? null : createNet( {
	room,
	seed: readSeedParam(),
	name: params.get( 'name' ) ?? '',
	onMessage: handleNetMessage,
	onStatus: handleNetStatus,
} );

// Scratch objects, so the per-frame transform maths allocates nothing.
const DOWN = new Vector3( 0, - 1, 0 );
const rayOrigin = new Vector3();
const groundRay = new Raycaster();
/** Reused result of the ground fit: the body's up vector and each wheel's suspension travel. */
const pose = { up: new Vector3(), travel: new Float32Array( 4 ), groundY: 0 };

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
 * Reads the seed from `?seed=`.
 *
 * @returns {number|null} The seed for this page load, or null when it should be drawn at
 *   random (the server decides for a room, and the client for a solo game).
 */
function readSeedParam() {

	const raw = params.get( 'seed' );

	if ( raw !== null ) {

		const parsed = Number.parseInt( raw, 10 );
		if ( Number.isFinite( parsed ) ) return Math.abs( parsed );

	}

	return null;

}

/**
 * Mirrors the active seed into the address bar so an island can be shared or reloaded.
 *
 * Online this is left alone: the island belongs to the room, and rewriting the URL would
 * silently move the player into another room on the next reload. The HUD shows the room
 * instead.
 *
 * @param {number} seed Active seed.
 * @returns {void}
 */
function writeSeedToUrl( seed ) {

	if ( net !== null ) return;
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

	if ( path !== null ) {

		scene.remove( path.group );
		path.dispose();
		path = null;

	}

	pathField = null;
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

	// The dirt path is drawn from the height field too, so it goes over the same hills the
	// car does. The path field is kept here (the module that builds the ribbon is handed it)
	// so the smoke test and the debug surface can ask where the loop actually runs.
	pathField = createPathField( field );
	path = createPath( field, { pathField } );

	scene.add( island.group );
	scene.add( props.group );
	scene.add( path.group );

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

	refreshLocalCollision();

	chase = createChaseCamera( camera, field );

	hud.setSeed( seed, online ? ` · room ${roomName}` : '' );
	writeSeedToUrl( seed );

	// The remote cars are on the old island: their buffers describe positions on terrain that
	// no longer exists, so they are dropped rather than interpolated across.
	remoteCars.clear();

}

/**
 * Chooses the collision registry the local car resolves trees against.
 *
 * Alone in the world, smashing a tree is the client's own business. In a room it is not: the
 * server owns which trees are standing, and reports a smash in a snapshot. So the *local*
 * car resolves against a read-only registry that reports the same hit — and therefore the same
 * speed loss, so the two simulations still agree tick for tick — without removing anything.
 * The tree actually vanishes a snapshot later, when the server says it did, and the debris
 * comes from that one event rather than from both sides at once.
 *
 * @returns {void}
 */
function refreshLocalCollision() {

	const readOnly = {
		queryNearby( x, z, radius, out ) {

			return trees.queryNearby( x, z, radius, out );

		},
		breakTree( tree ) {

			if ( tree.alive === false ) return null;

			// Same shape as `props.breakTree()`, minus the removal.
			return { x: tree.x, z: tree.z, y: tree.y, radius: tree.crownRadius };

		},
	};

	localCollision = online ? readOnly : collision;

}

/**
 * The spawn slot the room gave us, if any.
 *
 * In a room every player starts on their own slot around the island's spawn point, and both
 * sides have to agree on which one, or a respawn would put the local car somewhere the server
 * does not think it is. The slot arrives with the roster.
 *
 * @returns {{x: number, z: number, heading: number}|null} Our slot, or null when solo.
 */
function mySpawn() {

	const me = roster.find( ( player ) => player.id === selfId );

	return me?.spawn ?? null;

}

/**
 * Places (or re-places) the car on the current island.
 *
 * @returns {void}
 */
function spawnCar() {

	if ( carState === null ) {

		carState = createCarState( field, mySpawn() );

	} else {

		resetCar( carState, field, mySpawn() );

	}

	// The prediction is meaningless across a teleport, and its correction would drag the car
	// back towards where it used to be.
	prediction.reset();

	updateCarMesh( 0 );
	chase.snap();

}

/**
 * Copies the physics state onto the car meshes.
 *
 * The body is fitted to the terrain under all four wheels rather than to a single centre
 * sample: a rigid body has no suspension, so without this the car visibly hovers over bumps
 * and digs into dips. The fit itself lives in `carPose.js` and the transform it feeds in
 * `carTransform.js`, which the remote cars share.
 *
 * @param {number} dt Time step, used for the wheel roll rate.
 * @returns {void}
 */
function updateCarMesh( dt ) {

	// While the server is correcting us, the car is *drawn* at the corrected position rather
	// than simulated there: `renderState` is the simulated state plus whatever is left of the
	// last correction, which fades out over a few frames.
	prediction.update( dt, carState );

	fitCarToGround( field, prediction.renderState, car.wheelOffsets, pose );
	carTransform.apply( prediction.renderState, pose, dt );

}

/** Resets the car onto a valid spawn point, and tells the room about it. */
function respawnCar() {

	resetCar( carState, field, mySpawn() );
	prediction.reset();
	updateCarMesh( 0 );
	chase.snap();

	if ( net !== null ) net.send( protocol.respawn() );

}

/**
 * Generates a different island.
 *
 * Solo this is a local decision. In a room it is the server's — the island is shared, so
 * pressing R asks and the answer comes back as a `room` message, which rebuilds everyone's
 * world at once. Only the host is allowed to ask, and asking as anyone else is refused by the
 * server rather than quietly ignored.
 */
function regenerateIsland() {

	if ( net !== null ) {

		if ( online === false ) {

			statusText = 'not connected — try again in a moment';
			statusTimer = 2;
			return;

		}

		if ( isHost() === false ) {

			statusText = 'only the host can choose a new island';
			statusTimer = 2;
			return;

		}

		net.send( protocol.newIsland() );
		return;

	}

	buildIsland( randomSeed( WORLD.maxSeed ) );
	spawnCar();

}

/**
 * Whether this client is the room's host.
 *
 * @returns {boolean} True when we hold the room's "new island" button.
 */
function isHost() {

	const me = roster.find( ( player ) => player.id === selfId );

	return me?.host === true;

}

// ---------------------------------------------------------------- multiplayer plumbing

/**
 * Reacts to the socket opening, closing or falling back.
 *
 * The important part is `refreshLocalCollision()`: while the server is authoritative the local
 * car must not remove trees on its own, and when the connection drops the game becomes the
 * single player game again, where it must.
 *
 * @param {string} status One of `STATUS`.
 * @returns {void}
 */
function handleNetStatus( status ) {

	online = status === STATUS.online;

	if ( online ) {

		// Nothing from before the connection is worth replaying.
		prediction.reset();
		ticksSinceSend = 0;

	}

	refreshLocalCollision();
	hud.setConnection( describeConnection( status ) );

	if ( online === false ) {

		// The cars of a room we are no longer in are just abandoned meshes.
		remoteCars.sync( [], selfId, performance.now() );

	}

}

/**
 * A one-line description of the connection, for the HUD.
 *
 * @param {string} status Connection status.
 * @returns {string} Text to show.
 */
function describeConnection( status ) {

	if ( status === STATUS.full ) return 'room full — playing alone';

	const count = roster.length > 0 ? roster.length : 1;
	const people = count === 1 ? '1 player' : `${count} players`;

	if ( status === STATUS.online ) return `room ${roomName} · ${people}`;
	if ( status === STATUS.connecting ) return 'connecting…';
	if ( status === STATUS.offline ) return 'connection lost — retrying';

	return 'single player';

}

/**
 * Paints the local car the colour the room gave us.
 *
 * The server picks the colour, so it arrives after the car was built — and without this the
 * player would drive a red car while everyone else watched a green one.
 *
 * @returns {void}
 */
function applyOwnColor() {

	const me = roster.find( ( player ) => player.id === selfId );
	if ( me === undefined ) return;

	car.setPaint( me.color );

}

/**
 * Handles one frame from the server.
 *
 * @param {object} message Decoded frame.
 * @returns {void}
 */
function handleNetMessage( message ) {

	if ( message.t === 'welcome' ) {

		selfId = message.you;
		roomName = message.room;
		roster = message.players;

		// Simulate at the server's rate, whatever it is, so a replay is a replay.
		if ( Number.isFinite( message.tickRate ) && message.tickRate > 0 ) {

			tickStep = 1 / message.tickRate;

		}

		// The island is the room's, not the page's: if this client already generated a different
		// one (or is joining an existing room), it is replaced.
		if ( field === null || field.seed !== message.seed ) buildIsland( message.seed );

		remoteCars.sync( roster, selfId, performance.now() );
		spawnCar();
		applyOwnColor();

		hud.setSeed( message.seed, ` · room ${roomName}` );
		hud.setPlayers( roster, selfId );
		hud.setConnection( describeConnection( STATUS.online ) );
		return;

	}

	if ( message.t === 'join' ) {

		roster = roster.filter( ( player ) => player.id !== message.player.id );
		roster.push( message.player );
		roster.sort( ( a, b ) => a.id - b.id );

		remoteCars.sync( roster, selfId, performance.now() );
		hud.setPlayers( roster, selfId );
		hud.setConnection( describeConnection( STATUS.online ) );
		return;

	}

	if ( message.t === 'leave' ) {

		roster = roster.filter( ( player ) => player.id !== message.id );

		remoteCars.sync( roster, selfId, performance.now() );
		hud.setPlayers( roster, selfId );
		hud.setConnection( describeConnection( STATUS.online ) );
		return;

	}

	if ( message.t === 'room' ) {

		// A new island for everybody. The roster comes with it because the spawn slots moved.
		roster = message.players;
		buildIsland( message.seed );
		remoteCars.sync( roster, selfId, performance.now() );
		spawnCar();

		hud.setSeed( message.seed, ` · room ${roomName}` );
		hud.setPlayers( roster, selfId );

		statusText = 'new island for the room';
		statusTimer = 2;
		return;

	}

	if ( message.t === 'snapshot' ) {

		// Events first: they change which trees are standing, and the replay below has to see
		// the same trees the server did.
		remoteCars.applyEvents( message.e );

		const now = performance.now();
		remoteCars.pushPoses( message.p, now );

		const mine = message.p.find( ( entry ) => entry.id === selfId );

		if ( mine !== undefined && online ) {

			const result = prediction.reconcile( carState, mine, replayInput );

			// A correction too large to hide means the local car is somewhere the server does not
			// think it is: a respawn out of the sea, a stall, a new island. Rather than sliding
			// the car there, the camera is snapped with it.
			if ( result.snapped ) {

				updateCarMesh( 0 );
				chase.snap();

			}

		}

		return;

	}

	if ( message.t === 'full' ) {

		hud.setConnection( describeConnection( STATUS.full ) );
		return;

	}

	if ( message.t === 'error' ) {

		statusText = message.m;
		statusTimer = 3;
		hud.setStatus( statusText );

	}

}

/**
 * Replays one recorded input onto the local car, during a rollback.
 *
 * @param {object} tickInput The input the client used on that tick.
 * @returns {void}
 */
function replayInput( tickInput ) {

	stepCar( carState, tickInput, tickStep, field, { collision: localCollision } );

}

// ---------------------------------------------------------------- loop & lifecycle

/** Leftover real time not yet consumed by fixed steps. */
let accumulator = 0;

/** Status line shown by the HUD, and how long it stays up. */
let statusText = '';
let statusTimer = 0;

/**
 * Reacts to what happened during the physics step: spawns debris and posts HUD messages.
 *
 * @param {Array<object>} events Events from the step that just ran.
 * @param {number} dt Time step, so messages can expire.
 * @param {boolean} burstDebris Whether a smashed tree should throw shards here. In a room it
 *   must not: the tree is broken by the server's event instead, so the wreckage of every tree
 *   is identical for everyone, and only thrown once.
 * @returns {void}
 */
function handleEvents( events, dt, burstDebris ) {

	for ( const event of events ) {

		if ( event.type === 'treeBreak' ) {

			if ( burstDebris ) {

				debris.burst(
					event,
					Math.sin( carState.heading ) * carState.speed,
					Math.cos( carState.heading ) * carState.speed,
				);

			}

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
 * Steps the simulation once with the current input.
 *
 * Online the input is recorded first, so it can be replayed if the server's acknowledgement
 * disagrees with what we predicted, and batched up to be sent.
 *
 * @param {number} step Fixed time step, in seconds.
 * @returns {void}
 */
function simulateTick( step ) {

	if ( online ) {

		prediction.record( input );

		if ( ++ ticksSinceSend >= MULTIPLAYER.inputBatch ) {

			ticksSinceSend = 0;
			sendInputs();

		}

	}

	stepCar( carState, input, step, field, { collision: localCollision } );

}

/** Sends the inputs awaiting acknowledgement, as one batch. */
function sendInputs() {

	const batch = prediction.takeOutbox( MULTIPLAYER.maxInputsPerMessage );

	if ( batch === null ) return;

	net.send( protocol.input( batch.base, batch.inputs ) );

}

/**
 * One simulation + render step.
 *
 * The simulation runs on a fixed step accumulator rather than on the frame's own time. That is
 * what lets the client reproduce the server exactly: both sides advance the same simulation by
 * exactly `1 / tickRate` per tick, so replaying an input gives the same answer on both. It also
 * means the game behaves identically at 60 Hz, 144 Hz and everything between.
 *
 * @returns {void}
 */
function frame() {

	const dt = Math.min( clock.getDelta(), MAX_STEP );
	elapsed += dt;

	// Real time goes in, whole ticks come out: the remainder stays for the next frame, so the
	// simulation runs at exactly `tickRate` however fast the display refreshes.
	accumulator += dt;

	// A stalled frame is not caught up in full: five ticks of catch-up is plenty, and anything
	// past that is a tab that was hidden, not a frame that was slow.
	const steps = Math.min( MAX_STEPS_PER_FRAME, Math.floor( accumulator / tickStep ) );
	accumulator -= steps * tickStep;

	for ( let i = 0; i < steps; i ++ ) simulateTick( tickStep );

	updateCarMesh( dt );
	chase.update( dt, prediction.renderState, car.group );

	debris.update( dt );
	handleEvents( carState.events, dt, online === false );

	remoteCars.update( dt, performance.now() );

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

// A solo game draws its own island; a room is told which one to generate by `welcome`, which
// rebuilds it a moment later. Starting on a local island means there is something to look at
// while the socket connects.
buildIsland( readSeedParam() ?? randomSeed( WORLD.maxSeed ) );
spawnCar();
hud.setConnection( solo ? 'single player' : describeConnection( STATUS.connecting ) );
handleResize();
renderer.setAnimationLoop( frame );

if ( net !== null ) net.connect();

// Small debug surface: lets the console (or a smoke test) inspect and drive the game.
window.__carGame = {
	renderer,
	scene,
	camera,
	car,
	input,
	net,
	prediction,
	remoteCars,
	probeGround,
	regenerateIsland,
	respawnCar,
	/** Whether this page is playing alone, and whether the server is currently talking to us. */
	solo,
	get online() {

		return online;

	},
	get room() {

		return roomName;

	},
	get roster() {

		return roster;

	},
	get selfId() {

		return selfId;

	},
	step( dt = MAX_STEP, overrideInput = input ) {

		stepCar( carState, overrideInput, dt, field, { collision } );

		// Faithful to the real loop: events spawn debris and update the status line. Debris is
		// local here because this path is the single player / test path, never a room.
		handleEvents( carState.events, 0, true );
		updateCarMesh( dt );

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
	get path() {

		return path;

	},
	get pathField() {

		return pathField;

	},
	get debris() {

		return debris;

	},
	get collision() {

		return collision;

	},
};

