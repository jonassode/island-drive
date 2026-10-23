import { describe, expect, it } from 'vitest';
import { createPrediction } from '../src/multiplayer/prediction.js';
import { createRoom } from '../server/room.js';
import { createHeightField } from '../src/world/heightfield.js';
import { createPropSpots, toTreeRegistry } from '../src/game/propSpots.js';
import { createTreeField } from '../src/game/treeField.js';
import { createCarState, stepCar } from '../src/car/carPhysics.js';
import { MULTIPLAYER } from '../src/config.js';

const FIXED_STEP = 1 / MULTIPLAYER.tickRate;
const THROTTLE = { up: true, down: false, left: false, right: false };
const COAST = { up: false, down: false, left: false, right: false };

/**
 * Builds the tree collision world every simulation in this file shares.
 *
 * @param {number} seed Island seed.
 * @param {boolean} readOnly Whether breaking a tree only *reports* the hit, as the client's
 *   local registry does.
 * @returns {{ field: object, trees: Array<object>, collision: object }} The world.
 */
function world( seed, readOnly ) {

	const field = createHeightField( { seed } );
	const placement = createPropSpots( field );
	const trees = toTreeRegistry( placement.treeSpots, placement.config );
	const index = createTreeField( trees, { cellSize: 60 } );

	return {
		field,
		trees,
		collision: {
			queryNearby( x, z, radius, out ) {

				return index.queryNearby( x, z, radius, out );

			},
			breakTree( tree ) {

				if ( tree.alive === false ) return null;

				if ( readOnly === false ) tree.alive = false;

				return { x: tree.x, z: tree.z, y: tree.y, radius: tree.crownRadius };

			},
		},
	};

}

/**
 * Runs the same inputs twice on two identical islands: once straight through, and once through
 * the prediction machinery with a full rollback and replay.
 *
 * This is the property the whole multiplayer design rests on. The client and the server run the
 * same function on the same data, so replaying the inputs from an earlier state must land on
 * exactly the same state the straight run reached — not "close to", the same numbers.
 *
 * The two runs get their own copies of the island (same seed, so identical trees) because a
 * tree smashed by one run is not smashed in the other: sharing one registry would let the first
 * run clear the forest for the second, which is not what two machines do.
 *
 * @param {object} options Options.
 * @param {number} options.seed Island seed.
 * @param {number} options.ticks How many ticks to run.
 * @param {(tick: number) => object} [options.inputFor] Input generator.
 * @returns {{ client: object, reference: object, prediction: object, startPose: object,
 *   replay: (input: object) => void, trees: Array<object> }} The prediction run, the straight
 *   run, and how to replay.
 */
function runPair( { seed, ticks, inputFor = () => THROTTLE } ) {

	const spawn = { x: 0, z: 0, heading: 0 };
	const straight = world( seed, false );
	const predicted = world( seed, false );

	const reference = createCarState( straight.field, spawn );
	const client = createCarState( predicted.field, spawn );
	const prediction = createPrediction();
	/** The pose a snapshot from before the first tick would carry: ack 0, nothing simulated. */
	const startPose = poseOf( client );

	const replay = ( input ) => {

		stepCar( client, input, FIXED_STEP, predicted.field, { collision: predicted.collision } );

	};

	for ( let tick = 1; tick <= ticks; tick ++ ) {

		const input = inputFor( tick );

		prediction.record( input );
		stepCar( client, input, FIXED_STEP, predicted.field, { collision: predicted.collision } );
		stepCar( reference, input, FIXED_STEP, straight.field, { collision: straight.collision } );

	}

	return { client, reference, prediction, startPose, replay, trees: predicted.trees };

}

/**
 * The pose entry a snapshot would carry for a state, without the wire encoding.
 *
 * @param {object} state Car state.
 * @returns {object} Pose-shaped object.
 */
function poseOf( state ) {

	return {
		x: state.x,
		y: state.y,
		z: state.z,
		heading: state.heading,
		speed: state.speed,
		steer: state.steerAngle,
		vy: state.verticalSpeed,
		groundSpeed: state.groundSpeed,
		groundY: state.groundY,
		waterTime: state.waterTime,
		safeTimer: state.safeTimer,
		lastSafeX: state.lastSafe.x,
		lastSafeZ: state.lastSafe.z,
		lastSafeH: state.lastSafe.heading,
		flags: ( state.airborne ? 1 : 0 ) | ( state.inWater ? 2 : 0 ) | ( state.onLand ? 4 : 0 ),
	};

}

/**
 * Runs the whole client loop against a real room: predict, send, snapshot, reconcile.
 *
 * The tree state is shared through the room's events, exactly as the client's props mirror is
 * updated in the game, so this is the same loop the browser runs with the network replaced by a
 * function call.
 *
 * @param {object} options Options.
 * @param {number} options.seed Island seed.
 * @param {number} options.ticks How many ticks.
 * @param {(tick: number) => object} [options.inputFor] Input generator.
 * @param {number} [options.snapshotEvery] Ticks per snapshot.
 * @returns {{ errors: Array<number>, maxError: number, finalError: number, broken: number }} Result.
 */
function runSyncLoop( { seed, ticks, inputFor = () => THROTTLE, snapshotEvery = 3 } ) {

	const shared = world( seed, true ); // the client's registry: it reports hits, removes nothing
	const room = createRoom( { seed } );
	const player = room.addPlayer();

	const client = createCarState( shared.field, player.spawn );
	const prediction = createPrediction();
	const errors = [];
	let broken = 0;
	const events = [];

	const replay = ( input ) => {

		stepCar( client, input, FIXED_STEP, shared.field, { collision: shared.collision } );

	};

	for ( let tick = 1; tick <= ticks; tick ++ ) {

		const input = inputFor( tick );

		prediction.record( input );
		stepCar( client, input, FIXED_STEP, shared.field, { collision: shared.collision } );

		room.queueInputs( player.id, [ { seq: tick, input } ] );
		room.tick();

		events.push( ...room.drainEvents() );

		if ( tick % snapshotEvery !== 0 ) continue;

		// A snapshot arrives: the events in it are what actually removes a tree on the client,
		// so the removal is applied before the replay, exactly as `handleNetMessage` does.
		for ( const event of events ) {

			const tree = shared.trees[ event.tree ];
			if ( tree.alive ) {

				tree.alive = false;
				broken ++;

			}

		}

		events.length = 0;

		const mine = room.poses().find( ( entry ) => entry.id === player.id );
		prediction.reconcile( client, mine, replay );

		const server = room.stateOf( player.id );
		errors.push( Math.hypot( client.x - server.x, client.z - server.z ) );

	}

	return {
		errors,
		maxError: Math.max( ...errors ),
		finalError: errors[ errors.length - 1 ],
		broken,
		room,
		client,
	};

}

describe( 'prediction', () => {

	it( 'records inputs and takes them back out as a batch', () => {

		const prediction = createPrediction();

		expect( prediction.takeOutbox() ).toBeNull();

		prediction.record( THROTTLE );
		prediction.record( COAST );

		const batch = prediction.takeOutbox();

		expect( batch.base ).toBe( 1 );
		expect( batch.inputs ).toEqual( [ [ 1, 0, 0, 0 ], [ 0, 0, 0, 0 ] ] );
		expect( prediction.pending ).toBe( 2 );

		// Taken entries are not sent twice.
		expect( prediction.takeOutbox() ).toBeNull();

	} );

	it( 'never lets the outbox grow past a single message', () => {

		const prediction = createPrediction();

		for ( let i = 0; i < MULTIPLAYER.maxInputsPerMessage * 3; i ++ ) prediction.record( THROTTLE );

		const batch = prediction.takeOutbox( MULTIPLAYER.maxInputsPerMessage );

		expect( batch.inputs ).toHaveLength( MULTIPLAYER.maxInputsPerMessage );

	} );

	it( 'replays the unacknowledged inputs onto the server state exactly', () => {

		const { client, reference, prediction, startPose, replay, trees } = runPair( { seed: 7, ticks: MULTIPLAYER.replayMaxTicks } );

		// The car is genuinely moving, or this proves nothing.
		expect( Math.abs( reference.speed ) ).toBeGreaterThan( 10 );

		// Rewind the world with the car. A rollback that only rewound the car would replay onto
		// a forest the straight run had already flattened, and every tree it had smashed would
		// be missing. In the game the tree state is rewound too — by the server's events — so
		// this is the fair comparison: same world, same inputs, same answer.
		for ( const tree of trees ) tree.alive = true;

		prediction.reconcile( client, { ...startPose, ack: 0 }, replay );

		expect( client.x ).toBe( reference.x );
		expect( client.y ).toBe( reference.y );
		expect( client.z ).toBe( reference.z );
		expect( client.heading ).toBe( reference.heading );
		expect( client.speed ).toBe( reference.speed );
		expect( client.steerAngle ).toBe( reference.steerAngle );
		expect( client.verticalSpeed ).toBe( reference.verticalSpeed );
		expect( client.airborne ).toBe( reference.airborne );
		expect( prediction.pending ).toBe( MULTIPLAYER.replayMaxTicks );

	} );

	it( 'caps how far back it will replay, dropping the oldest inputs', () => {

		const prediction = createPrediction();

		for ( let i = 0; i < MULTIPLAYER.replayMaxTicks * 2; i ++ ) prediction.record( THROTTLE );

		expect( prediction.pending ).toBe( MULTIPLAYER.replayMaxTicks );

	} );

	it( 'drops the inputs the server has acknowledged', () => {

		const { client, prediction, replay } = runPair( { seed: 7, ticks: 30 } );

		expect( prediction.pending ).toBe( 30 );

		prediction.reconcile( client, { ...poseOf( client ), ack: 20 }, replay );

		expect( prediction.pending ).toBe( 10 );

	} );

	it( 'keeps the predicted car on the server through a long run, trees and all', () => {

		// 900 ticks is 15 seconds at full throttle: long enough to smash into a thicket, be
		// slowed by the sea, respawn, and have all of it reconciled.
		const result = runSyncLoop( { seed: 7, ticks: 900 } );

		expect( result.broken ).toBeGreaterThan( 0 );

		// The whole point: the client and the server never drift apart by more than a nudge,
		// which is what lets the correction be smoothed rather than snapped.
		expect( result.maxError ).toBeLessThan( MULTIPLAYER.snapDistance );

		// And after the last snapshot the client is exactly where the server is.
		expect( result.finalError ).toBe( 0 );

	} );

	it( 'stays in step while steering and braking, not just on a straight line', () => {

		const result = runSyncLoop( {
			seed: 99,
			ticks: 720,
			inputFor: ( tick ) => ( {
				up: Math.floor( tick / 90 ) % 2 === 0,
				down: false,
				left: Math.floor( tick / 240 ) % 2 === 1,
				right: Math.floor( tick / 120 ) % 3 === 2,
			} ),
		} );

		const server = result.room.stateOf( result.room.listPlayers()[ 0 ].id );
		const start = result.room.listPlayers()[ 0 ].spawn;

		// It really drove: a car that never left its slot would make the error check meaningless.
		expect( Math.hypot( server.x - start.x, server.z - start.z ) ).toBeGreaterThan( 30 );
		expect( result.maxError ).toBeLessThan( MULTIPLAYER.snapDistance );
		expect( result.finalError ).toBe( 0 );

	} );

	it( 'smooths a small correction instead of teleporting', () => {

		const prediction = createPrediction();
		const state = { x: 10, y: 0, z: 10, heading: 0, speed: 0, steerAngle: 0, airborne: false, inWater: false, lastSafe: { x: 0, z: 0, heading: 0 }, events: [], verticalSpeed: 0, groundSpeed: 0, groundY: 0, waterTime: 0, safeTimer: 0, onLand: true, bumped: false, blocked: false };

		prediction.update( 0, state );
		expect( prediction.renderState.x ).toBe( 10 );

		// A snapshot half a metre away: no replay needed, and no snap.
		const result = prediction.reconcile( state, {
			...poseOf( { ...state, lastSafe: state.lastSafe } ),
			x: 10.5,
			ack: 0,
		}, () => {} );

		expect( result.snapped ).toBe( false );
		expect( prediction.snaps ).toBe( 0 );

		// The car is still drawn where it was, so nothing visibly jumps...
		prediction.update( 0, state );
		expect( prediction.renderState.x ).toBeCloseTo( 10, 6 );

		// ...and the correction decays towards the server's position.
		for ( let i = 0; i < 60; i ++ ) prediction.update( 1 / 60, state );

		expect( prediction.errorMagnitude ).toBeLessThan( 0.01 );
		expect( prediction.renderState.x ).toBeCloseTo( 10.5, 2 );

	} );

	it( 'snaps a correction too large to hide, and counts it', () => {

		const prediction = createPrediction();
		const state = { x: 0, y: 0, z: 0, heading: 0, speed: 0, steerAngle: 0, airborne: false, inWater: false, lastSafe: { x: 0, z: 0, heading: 0 }, events: [], verticalSpeed: 0, groundSpeed: 0, groundY: 0, waterTime: 0, safeTimer: 0, onLand: true, bumped: false, blocked: false };

		const result = prediction.reconcile( state, {
			...poseOf( state ),
			x: 500,
			z: - 300,
			ack: 0,
		}, () => {} );

		expect( result.snapped ).toBe( true );
		expect( result.distance ).toBeCloseTo( Math.hypot( 500, 300 ), 6 );
		expect( prediction.snaps ).toBe( 1 );
		expect( prediction.errorMagnitude ).toBe( 0 );

	} );

	it( 'forgets everything on reset', () => {

		const prediction = createPrediction();

		prediction.record( THROTTLE );
		prediction.record( THROTTLE );

		expect( prediction.pending ).toBe( 2 );
		expect( prediction.takeOutbox() ).not.toBeNull();

		prediction.reset();

		expect( prediction.pending ).toBe( 0 );
		expect( prediction.takeOutbox() ).toBeNull();
		expect( prediction.errorMagnitude ).toBe( 0 );

		// The sequence keeps climbing, so the server never sees a repeat.
		expect( prediction.record( THROTTLE ).seq ).toBe( 3 );

	} );

} );