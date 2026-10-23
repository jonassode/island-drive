import { describe, expect, it } from 'vitest';
import { createRoom, spawnSlot } from '../server/room.js';
import { createHeightField } from '../src/world/heightfield.js';
import { MULTIPLAYER, PROPS } from '../src/config.js';

/** A fixed random source, so colour choice is reproducible in these tests. */
const firstColor = () => 0;

/**
 * Runs a room for a while with everybody holding the throttle.
 *
 * @param {object} room Room.
 * @param {number} ticks How many ticks.
 * @param {object} [inputs] Per player id input; straight ahead by default.
 * @returns {void}
 */
function drive( room, ticks, inputs = {} ) {

	for ( let seq = 1; seq <= ticks; seq ++ ) {

		for ( const player of room.listPlayers() ) {

			const input = inputs[ player.id ] ?? { up: true, down: false, left: false, right: false };

			room.queueInputs( player.id, [ { seq, input } ] );

		}

		room.tick();

	}

}

describe( 'room', () => {

	it( 'starts a player on their own spawn slot on dry land', () => {

		const room = createRoom( { seed: 7 } );
		const a = room.addPlayer( { name: 'Ana' } );
		const b = room.addPlayer( { name: 'Bo' } );

		for ( const player of [ a, b ] ) {

			expect( room.field.isLand( player.spawn.x, player.spawn.z ) ).toBe( true );
			expect( room.stateOf( player.id ).onLand ).toBe( true );

		}

		// Far enough apart that two cars do not start inside each other.
		expect( Math.hypot( a.spawn.x - b.spawn.x, a.spawn.z - b.spawn.z ) ).toBeGreaterThan( 4 );

	} );

	it( 'keeps spawn slots inside the tree-free spawn clearance', () => {

		const room = createRoom( { seed: 7 } );
		const base = room.field.findSpawnPoint();

		for ( let index = 0; index < MULTIPLAYER.maxPlayers; index ++ ) {

			const slot = spawnSlot( room.field, base, index );

			expect( room.field.isLand( slot.x, slot.z ) ).toBe( true );
			expect( Math.hypot( slot.x - base.x, slot.z - base.z ) )
				.toBeLessThanOrEqual( PROPS.spawnClearance );

			// No tree in reach of any slot, so nobody spawns wedged in a trunk.
			for ( const tree of room.trees ) {

				expect( Math.hypot( tree.x - slot.x, tree.z - slot.z ) ).toBeGreaterThan( tree.radius );

			}

		}

	} );

	it( 'hands every player a different colour', () => {

		const room = createRoom( { seed: 1, random: firstColor } );
		const colors = [];

		for ( let i = 0; i < MULTIPLAYER.maxPlayers; i ++ ) colors.push( room.addPlayer().color );

		expect( new Set( colors ).size ).toBe( MULTIPLAYER.maxPlayers );

	} );

	it( 'refuses a player once it is full, and frees the slot when somebody leaves', () => {

		const room = createRoom( { seed: 1 } );
		const players = [];

		for ( let i = 0; i < MULTIPLAYER.maxPlayers; i ++ ) players.push( room.addPlayer() );

		expect( room.full ).toBe( true );
		expect( room.addPlayer() ).toBeNull();

		const slot = players[ 2 ].slot;
		room.removePlayer( players[ 2 ].id );

		const replacement = room.addPlayer();

		expect( replacement ).not.toBeNull();
		expect( replacement.slot ).toBe( slot );
		expect( replacement.color ).toBe( players[ 2 ].color );

	} );

	it( 'names the first player host, and the next one in line after they leave', () => {

		const room = createRoom( { seed: 1 } );
		const a = room.addPlayer( { name: 'Ana' } );
		const b = room.addPlayer( { name: 'Bo' } );

		expect( room.host ).toBe( a.id );
		expect( room.roster().find( ( p ) => p.id === a.id ).host ).toBe( true );

		room.removePlayer( a.id );

		expect( room.host ).toBe( b.id );

	} );

	it( 'stalls a player whose inputs have not arrived, instead of guessing', () => {

		const room = createRoom( { seed: 7 } );
		const player = room.addPlayer();

		room.queueInputs( player.id, [ { seq: 1, input: { up: true, down: false, left: false, right: false } } ] );
		room.tick();

		const afterOneTick = { x: room.stateOf( player.id ).x, z: room.stateOf( player.id ).z };

		// Five ticks with nothing queued: the car must not move an inch.
		for ( let i = 0; i < 5; i ++ ) room.tick();

		expect( room.stateOf( player.id ).x ).toBe( afterOneTick.x );
		expect( room.stateOf( player.id ).z ).toBe( afterOneTick.z );

	} );

	it( 'acknowledges inputs in the order it applied them', () => {

		const room = createRoom( { seed: 7 } );
		const player = room.addPlayer();
		const throttle = { up: true, down: false, left: false, right: false };

		room.queueInputs( player.id, [ { seq: 1, input: throttle }, { seq: 2, input: throttle } ] );

		room.tick();
		expect( room.poses()[ 0 ].ack ).toBe( 1 );

		room.tick();
		expect( room.poses()[ 0 ].ack ).toBe( 2 );

		// An input that has already been simulated is not applied a second time.
		expect( room.queueInputs( player.id, [ { seq: 2, input: throttle } ] ) ).toBe( 0 );

	} );

	it( 'drives a car on the same island the clients generate', () => {

		const room = createRoom( { seed: 99 } );
		const player = room.addPlayer();

		drive( room, 600 );

		const state = room.stateOf( player.id );

		expect( Math.hypot( state.x, state.z ) ).toBeGreaterThan( 50 );
		expect( Math.abs( state.speed ) ).toBeGreaterThan( 1 );

		// The clients regenerate this island from the seed alone, and sample the same terrain.
		const clientField = createHeightField( { seed: 99 } );

		expect( clientField.seed ).toBe( room.field.seed );
		expect( clientField.heightAt( state.x, state.z ) ).toBe( room.field.heightAt( state.x, state.z ) );

	} );

	it( 'is deterministic: the same inputs produce the same result', () => {

		const build = () => {

			const room = createRoom( { seed: 42, random: firstColor } );
			room.addPlayer( { name: 'Ana' } );
			room.addPlayer( { name: 'Bo' } );
			drive( room, 300 );

			return room.listPlayers().map( ( player ) => room.stateOf( player.id ) );
		};

		const one = build();
		const two = build();

		for ( let i = 0; i < one.length; i ++ ) {

			expect( two[ i ].x ).toBe( one[ i ].x );
			expect( two[ i ].y ).toBe( one[ i ].y );
			expect( two[ i ].z ).toBe( one[ i ].z );
			expect( two[ i ].heading ).toBe( one[ i ].heading );
			expect( two[ i ].speed ).toBe( one[ i ].speed );

		}

	} );

	it( 'breaks a tree once, and reports it as one event', () => {

		const room = createRoom( { seed: 7 } );
		const player = room.addPlayer();
		const events = [];

		for ( let seq = 1; seq <= 900 && events.length === 0; seq ++ ) {

			room.queueInputs( player.id, [ { seq, input: { up: true, down: false, left: false, right: false } } ] );
			room.tick();

			events.push( ...room.drainEvents() );

		}

		expect( events.length ).toBeGreaterThan( 0 );

		const event = events[ 0 ];

		expect( event.type ).toBe( 'treeBreak' );
		expect( room.trees[ event.tree ].alive ).toBe( false );

		// Draining takes the events with it, so they are never sent twice.
		expect( room.drainEvents() ).toEqual( [] );

	} );

	it( 'puts everybody back on their slot when the island changes', () => {

		const room = createRoom( { seed: 7 } );
		const a = room.addPlayer();
		const b = room.addPlayer();

		drive( room, 120 );

		const seed = room.newIsland();

		expect( seed ).not.toBe( 7 );
		expect( room.seed ).toBe( seed );

		for ( const player of [ a, b ] ) {

			const state = room.stateOf( player.id );

			expect( state.x ).toBe( player.spawn.x );
			expect( state.z ).toBe( player.spawn.z );
			expect( state.speed ).toBe( 0 );
			expect( room.field.isLand( state.x, state.z ) ).toBe( true );

		}

	} );

	it( 'respawns a player on request, forgetting the inputs around the reset', () => {

		const room = createRoom( { seed: 7 } );
		const player = room.addPlayer();

		drive( room, 120 );

		// An input sent before the reset arrives, and must not undo it.
		room.queueInputs( player.id, [ { seq: 121, input: { up: true, down: false, left: false, right: false } } ] );
		expect( room.respawn( player.id ) ).toBe( true );

		const state = room.stateOf( player.id );

		expect( state.x ).toBe( player.spawn.x );
		expect( state.z ).toBe( player.spawn.z );

		room.tick();

		expect( room.stateOf( player.id ).x ).toBe( player.spawn.x );
		expect( room.respawn( 999 ) ).toBe( false );

	} );

	it( 'describes every car in a snapshot pose', () => {

		const room = createRoom( { seed: 7 } );
		const player = room.addPlayer( { name: 'Ana' } );

		drive( room, 60 );

		const poses = room.poses();

		expect( poses ).toHaveLength( 1 );

		for ( const key of [ 'id', 'x', 'y', 'z', 'heading', 'speed', 'steer', 'vy',
			'groundSpeed', 'groundY', 'waterTime', 'safeTimer', 'lastSafeX', 'lastSafeZ',
			'lastSafeH', 'flags', 'ack' ] ) {

			expect( poses[ 0 ][ key ] ).toBeDefined();

		}

		expect( poses[ 0 ].id ).toBe( player.id );
		expect( poses[ 0 ].ack ).toBe( 60 );

	} );

	it( 'renames a player, and sanitizes what it is given', () => {

		const room = createRoom( { seed: 1 } );
		const player = room.addPlayer( { name: 'Ana' } );

		expect( room.setName( player.id, '  Bo\u0007  ' ) ).toBe( true );
		expect( room.roster()[ 0 ].name ).toBe( 'Bo' );
		expect( room.setName( 999, 'nope' ) ).toBe( false );

	} );

	it( 'gives two rooms on the same seed the same trees', () => {

		const a = createRoom( { seed: 5 } );
		const b = createRoom( { seed: 5 } );

		expect( a.trees.length ).toBe( b.trees.length );
		expect( a.trees[ 100 ] ).toEqual( b.trees[ 100 ] );

	} );

} );