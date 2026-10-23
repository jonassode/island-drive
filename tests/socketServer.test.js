import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { attachGameServer } from '../server/socketServer.js';

/** Servers started by a test, torn down afterwards. */
const running = [];

/**
 * Starts an HTTP server with the game socket attached, on a free port.
 *
 * @param {object} [config] Overrides for the server's copy of {@link MULTIPLAYER}.
 * @returns {Promise<{ port: number, dispose: () => void, rooms: Map<string, object> }>} Server.
 */
function startServer( config = {} ) {

	return new Promise( ( resolve ) => {

		const server = createServer( ( request, response ) => response.end( 'ok' ) );
		// Faster than the defaults, so a test does not spend whole seconds waiting for ticks.
		const game = attachGameServer( server, {
			config: { tickRate: 120, snapshotRate: 40, heartbeatMs: 500, ...config },
		} );

		server.listen( 0, '127.0.0.1', () => {

			const entry = {
				port: server.address().port,
				rooms: game.rooms,
				dispose() {

					game.dispose();
					server.close();

				},
			};

			running.push( entry );
			resolve( entry );

		} );

	} );

}

/**
 * Connects a client and lets a test claim the frames it receives.
 *
 * @param {number} port Server port.
 * @param {string} query URL query, e.g. `room=test`.
 * @returns {object} The client.
 */
function connect( port, query ) {

	const ws = new WebSocket( `ws://127.0.0.1:${port}/ws?${query}` );
	const messages = [];
	const waiters = [];

	ws.on( 'message', ( data ) => {

		messages.push( JSON.parse( data ) );
		waiters.splice( 0 ).forEach( ( wake ) => wake() );

	} );

	/**
	 * Takes the next queued frame of a type.
	 *
	 * @param {string} type Message type.
	 * @returns {object|null} The frame.
	 */
	function claim( type ) {

		const index = messages.findIndex( ( message ) => message.t === type );
		if ( index === - 1 ) return null;

		return messages.splice( index, 1 )[ 0 ];

	}

	return {
		ws,

		/**
		 * Waits for the next frame of a given type, and claims it.
		 *
		 * @param {string} type Message type.
		 * @param {number} [timeout] How long to wait, in ms.
		 * @returns {Promise<object>} The frame.
		 */
		next( type, timeout = 3000 ) {

			const immediate = claim( type );
			if ( immediate !== null ) return Promise.resolve( immediate );

			return new Promise( ( resolve, reject ) => {

				const timer = setTimeout(
					() => reject( new Error( `no "${type}" within ${timeout}ms` ) ),
					timeout,
				);

				waiters.push( () => {

					const message = claim( type );
					if ( message === null ) return;

					clearTimeout( timer );
					resolve( message );

				} );

			} );

		},

		/** Waits for the socket to open, so a send cannot be dropped. */
		ready() {

			return ws.readyState === WebSocket.OPEN
				? Promise.resolve()
				: new Promise( ( resolve ) => ws.on( 'open', resolve ) );

		},

		send( message ) {

			ws.send( JSON.stringify( message ) );

		},

		close() {

			ws.close();

		},
	};

}

/**
 * Waits for a snapshot in which a condition holds.
 *
 * @param {object} client Client to read snapshots from.
 * @param {(pose: object) => boolean} predicate Condition.
 * @param {number} [attempts] How many snapshots to try before giving up.
 * @returns {Promise<boolean>} Whether it came true.
 */
async function waitForPose( client, predicate, attempts = 200 ) {

	for ( let i = 0; i < attempts; i ++ ) {

		const snapshot = await client.next( 'snapshot' );
		if ( predicate( snapshot.p[ 0 ] ) ) return true;

	}

	return false;

}

/**
 * Starts driving a client, one input per tick at a realistic pace, until told to stop.
 *
 * Sending a burst of inputs at once would be dropped by the server, quite deliberately: a
 * client that far ahead of the tick loop is not allowed to fast-forward its car. So the sends
 * are paced the way the real client's are, and the test waits for a *condition* rather than for
 * a stopwatch — a machine under load moves the car more slowly, not wrongly.
 *
 * @param {object} client Client.
 * @param {number} [tickRate] Ticks per second to keep up with.
 * @returns {{ stop: () => Promise<number> }} Handle whose `stop()` returns the next free
 *   sequence number.
 */
function startDriving( client, tickRate = 120 ) {

	const state = { seq: 1, stopped: false };

	const running = ( async () => {

		while ( state.stopped === false ) {

			client.send( { t: 'input', base: state.seq, i: [ [ 1, 0, 0, 0 ] ] } );
			state.seq ++;

			await new Promise( ( resolve ) => setTimeout( resolve, 1000 / tickRate ) );

		}

	} )();

	return {
		async stop() {

			state.stopped = true;
			await running;

			return state.seq;

		},
	};

}

afterEach( () => {

	while ( running.length > 0 ) running.pop().dispose();

} );

describe( 'game socket', () => {

	it( 'welcomes a client with the room, the island and the roster', async () => {

		const server = await startServer();
		const player = connect( server.port, 'room=test&seed=7&name=Ana' );
		const welcome = await player.next( 'welcome' );

		expect( welcome.room ).toBe( 'test' );
		expect( welcome.seed ).toBe( 7 );
		expect( welcome.you ).toBe( 1 );
		expect( welcome.tickRate ).toBe( 120 );
		expect( welcome.players ).toHaveLength( 1 );
		expect( welcome.players[ 0 ].name ).toBe( 'Ana' );
		expect( welcome.players[ 0 ].host ).toBe( true );
		expect( typeof welcome.players[ 0 ].color ).toBe( 'number' );
		expect( welcome.players[ 0 ].spawn ).toBeDefined();

		player.close();

	} );

	it( 'puts two players in one room, on one island, with different colours', async () => {

		const server = await startServer();
		const ana = connect( server.port, 'room=test&seed=12&name=Ana' );
		const a = await ana.next( 'welcome' );

		const bo = connect( server.port, 'room=test&name=Bo' );
		const b = await bo.next( 'welcome' );

		// The second player joins the island the room already has, not one of their own.
		expect( b.seed ).toBe( a.seed );
		expect( b.room ).toBe( 'test' );
		expect( b.players ).toHaveLength( 2 );
		expect( b.players[ 0 ].color ).not.toBe( b.players[ 1 ].color );

		// And the first player is told about the second.
		const update = await ana.next( 'welcome' );
		expect( update.players ).toHaveLength( 2 );
		expect( update.you ).toBe( a.you );
		expect( update.players.filter( ( player ) => player.host ) ).toHaveLength( 1 );

		ana.close();
		bo.close();

	} );

	it( 'tells the room when somebody leaves', async () => {

		const server = await startServer();
		const ana = connect( server.port, 'room=test&name=Ana' );
		await ana.next( 'welcome' );

		const bo = connect( server.port, 'room=test&name=Bo' );
		const boWelcome = await bo.next( 'welcome' );
		await ana.next( 'welcome' );

		bo.close();

		expect( ( await ana.next( 'leave' ) ).id ).toBe( boWelcome.you );

		ana.close();

	} );

	it( 'broadcasts snapshots, and only moves a car whose input arrived', async () => {

		const server = await startServer();
		const ana = connect( server.port, 'room=test&seed=3&name=Ana' );
		const welcome = await ana.next( 'welcome' );
		await ana.ready();

		// The first snapshot lands before any input can have been applied, so the car is still
		// on its spawn slot and nothing has been acknowledged.
		const first = await ana.next( 'snapshot' );

		expect( first.p[ 0 ].id ).toBe( welcome.you );
		expect( first.p[ 0 ].x ).toBe( welcome.players[ 0 ].spawn.x );
		expect( first.p[ 0 ].z ).toBe( welcome.players[ 0 ].spawn.z );
		expect( first.p[ 0 ].ack ).toBe( 0 );

		// Driving is asynchronous: the snapshot stream carries on while the inputs go out, and
		// the wait is for the car to have moved rather than for a stopwatch to expire.
		const driving = startDriving( ana );
		const slot = welcome.players[ 0 ].spawn;

		expect( await waitForPose( ana, ( pose ) => pose.ack >= 1 ) ).toBe( true );
		expect( await waitForPose(
			ana,
			( pose ) => Math.hypot( pose.x - slot.x, pose.z - slot.z ) > 8,
		) ).toBe( true );

		await driving.stop();
		ana.close();

	} );

	it( 'reports a malformed frame rather than failing on it', async () => {

		const server = await startServer();
		const ana = connect( server.port, 'room=test&name=Ana' );
		await ana.next( 'welcome' );
		await ana.ready();

		ana.ws.send( 'not json at all' );
		expect( ( await ana.next( 'error' ) ).m ).toBe( 'unreadable frame' );

		ana.send( { t: 'input', base: 1, i: 'nope' } );
		expect( ( await ana.next( 'error' ) ).m ).toBe( 'malformed input batch' );

		ana.send( { t: 'what' } );
		expect( ( await ana.next( 'error' ) ).m ).toContain( 'unknown frame' );

		ana.close();

	} );

	it( 'lets the host change the island, and refuses everybody else', async () => {

		const server = await startServer();
		const ana = connect( server.port, 'room=test&seed=4&name=Ana' );
		const a = await ana.next( 'welcome' );

		const bo = connect( server.port, 'room=test&name=Bo' );
		await bo.next( 'welcome' );
		await ana.next( 'welcome' );
		await ana.ready();
		await bo.ready();

		bo.send( { t: 'newIsland' } );
		expect( ( await bo.next( 'error' ) ).m ).toContain( 'host' );

		ana.send( { t: 'newIsland' } );

		const changed = await bo.next( 'room' );

		expect( changed.seed ).not.toBe( a.seed );
		expect( changed.players ).toHaveLength( 2 );
		expect( ( await ana.next( 'room' ) ).seed ).toBe( changed.seed );

		ana.close();
		bo.close();

	} );

	it( 'respawns a player on request', async () => {

		const server = await startServer();
		const ana = connect( server.port, 'room=test&seed=8&name=Ana' );
		const welcome = await ana.next( 'welcome' );
		const slot = welcome.players[ 0 ].spawn;

		await ana.next( 'snapshot' );
		await ana.ready();

		const driving = startDriving( ana );

		expect( await waitForPose( ana, ( pose ) => Math.hypot( pose.x - slot.x, pose.z - slot.z ) > 8 ) ).toBe( true );

		const nextSeq = await driving.stop();

		ana.send( { t: 'respawn' } );

		expect( await waitForPose( ana, ( pose ) => pose.x === slot.x && pose.z === slot.z && pose.speed === 0 ) ).toBe( true );

		// The sequence numbering carries on from where the driving stopped, and the server
		// acknowledges by sequence rather than by count — so a respawn never confuses it.
		expect( nextSeq ).toBeGreaterThan( 1 );

		ana.close();

	} );

	it( 'drops an empty room, and gives the next visitor a fresh island', async () => {

		const server = await startServer();
		const ana = connect( server.port, 'room=alone&seed=5' );
		const a = await ana.next( 'welcome' );

		expect( server.rooms.has( 'alone' ) ).toBe( true );

		ana.close();
		await new Promise( ( resolve ) => setTimeout( resolve, 50 ) );

		expect( server.rooms.has( 'alone' ) ).toBe( false );

		const next = connect( server.port, 'room=alone' );
		const b = await next.next( 'welcome' );

		expect( b.seed ).not.toBe( a.seed );
		expect( b.you ).toBe( 1 );

		next.close();

	} );

	it( 'gives a full room the brush-off instead of a seat', async () => {

		const server = await startServer( { maxPlayers: 2 } );

		const one = connect( server.port, 'room=busy' );
		const two = connect( server.port, 'room=busy' );
		await one.next( 'welcome' );
		await two.next( 'welcome' );

		const three = connect( server.port, 'room=busy' );
		expect( ( await three.next( 'full' ) ).max ).toBe( 2 );

		one.close();
		two.close();

	} );

	it( 'keeps separate rooms separate', async () => {

		const server = await startServer();

		const one = connect( server.port, 'room=alpha&seed=2&name=Ana' );
		const two = connect( server.port, 'room=beta&seed=3&name=Bo' );

		const a = await one.next( 'welcome' );
		const b = await two.next( 'welcome' );

		expect( a.room ).toBe( 'alpha' );
		expect( b.room ).toBe( 'beta' );
		expect( a.seed ).toBe( 2 );
		expect( b.seed ).toBe( 3 );

		// Neither hears about the other.
		one.send( { t: 'input', base: 1, i: [ [ 1, 0, 0, 0 ] ] } );
		expect( ( await one.next( 'snapshot' ) ).p ).toHaveLength( 1 );

		one.close();
		two.close();

	} );

} );