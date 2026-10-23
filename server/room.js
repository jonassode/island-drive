/**
 * A room: the authoritative simulation of one island and everyone driving on it.
 *
 * This is the multiplayer game, and it knows nothing about sockets — it is handed inputs and
 * it produces snapshots, which makes it testable in Node at full speed. It runs on the same
 * modules the browser does: the island comes from {@link ../src/world/heightfield.js}, the
 * trees from {@link ../src/game/propSpots.js}, and each car from
 * {@link ../src/car/carPhysics.js}'s `stepCar`. Because both sides step the same simulation at
 * the same fixed rate, a client can predict its own car and be right almost every time.
 *
 * Rules worth knowing:
 *
 * - One input is consumed per tick, in order. A player whose inputs have not arrived yet is
 *   simply not stepped this tick — a brief stall, never a teleport.
 * - The server owns every *world* consequence (a smashed tree, a respawn out of the sea), and
 *   reports them in the snapshot, so every client sees the same wreckage.
 * - Nothing is persisted. An empty room is dropped by the caller and the next visitor gets a
 *   brand new island.
 */

import { createCarState, resetCar, stepCar } from '../src/car/carPhysics.js';
import { createHeightField } from '../src/world/heightfield.js';
import { createPropSpots, toTreeRegistry } from '../src/game/propSpots.js';
import { createTreeField } from '../src/game/treeField.js';
import { pickColor } from '../src/multiplayer/palette.js';
import { pose, sanitizeName } from '../src/multiplayer/protocol.js';
import { randomSeed } from '../src/world/rng.js';
import { MULTIPLAYER, WORLD } from '../src/config.js';

/** Spread of the spawn slots around the island's own spawn point, in radians. */
const GOLDEN_ANGLE = Math.PI * ( 3 - Math.sqrt( 5 ) );

/**
 * Where player `index` starts.
 *
 * Slots sit on rings around the terrain's own spawn point, which is itself chosen flat and
 * clear of trees, and `PROPS.spawnClearance` keeps every slot inside that tree-free zone — so
 * nobody ever starts wedged in a trunk. A slot that lands in the sea (a very lopsided island)
 * is pulled in towards the spawn point until it is dry land.
 *
 * @param {object} field Terrain.
 * @param {{x: number, z: number}} base The terrain's own spawn point.
 * @param {number} index Slot index, i.e. the player's position in the room.
 * @param {object} config Room tunables.
 * @returns {{x: number, z: number, heading: number}} The spawn slot.
 */
export function spawnSlot( field, base, index, config = MULTIPLAYER ) {

	const angle = index * GOLDEN_ANGLE;
	const ring = 1 + Math.floor( index / config.maxPlayers );
	let radius = Math.min( config.spawnRingRadius * ring, config.spawnMaxRadius );

	for ( let attempt = 0; attempt < 5; attempt ++ ) {

		const x = base.x + Math.cos( angle ) * radius;
		const z = base.z + Math.sin( angle ) * radius;

		// Facing along the ring rather than at its centre: a starting grid pointing the same
		// way round the island, which is also the way the dirt path runs.
		if ( field.isLand( x, z ) ) return { x, z, heading: - angle };

		radius *= 0.6;

	}

	return { x: base.x, z: base.z, heading: - angle };

}

/**
 * Creates a room on a fresh island.
 *
 * @param {object} [options] Options.
 * @param {string} [options.id] Room id, for display and logging.
 * @param {number} [options.seed] Island seed. Random when omitted.
 * @param {object} [options.config] Overrides for {@link MULTIPLAYER}.
 * @param {() => number} [options.random] Random source, injectable for tests.
 * @returns {object} The room.
 */
export function createRoom( options = {} ) {

	const config = { ...MULTIPLAYER, ...options.config };
	const random = options.random ?? Math.random;
	const id = options.id ?? config.room;
	const step = 1 / config.tickRate;

	const players = new Map();
	let nextId = 1;
	let tickCount = 0;
	let pendingEvents = [];

	// --- the island, and everything on it -------------------------------------------------
	let seed = options.seed ?? randomSeed( WORLD.maxSeed );
	let field = null;
	let treeRegistry = null;
	let treeField = null;
	let collision = null;
	let spawnBase = null;

	/**
	 * Rebuilds the island from the current seed.
	 *
	 * Runs on creation and on a room-wide "new island", and is the reason a client can join
	 * with nothing but a seed: the terrain, the trees and the dirt path are all derived from
	 * it on both sides.
	 *
	 * @returns {void}
	 */
	function buildIsland() {

		field = createHeightField( { seed } );

		const placement = createPropSpots( field );
		treeRegistry = toTreeRegistry( placement.treeSpots, placement.config );
		treeField = createTreeField( treeRegistry, { cellSize: 60 } );

		// The authoritative collision world, with no meshes: a broken tree is just a flag, and
		// the `treeBreak` event carries the instance index the clients draw from.
		collision = {
			queryNearby( x, z, radius, out ) {

				return treeField.queryNearby( x, z, radius, out );

			},
			breakTree( tree ) {

				if ( tree.alive === false ) return null;

				tree.alive = false;

				return {
					index: tree.index,
					x: tree.x,
					z: tree.z,
					y: tree.y,
					radius: tree.crownRadius,
				};

			},
		};

		spawnBase = field.findSpawnPoint();

		// Existing players are moved onto the new island's slots, and their pending inputs are
		// dropped so a client cannot be dragged back to where it was before the new island.
		for ( const player of players.values() ) {

			player.spawn = spawnSlot( field, spawnBase, player.slot, config );
			resetCar( player.state, field, player.spawn );
			player.queue.length = 0;
			player.ack = player.nextSeq - 1;

		}

	}

	// --- players ---------------------------------------------------------------------------

	/**
	 * The room's host: the player who has been here longest.
	 *
	 * The host owns the "new island" button, so nobody's lap is ruined by a stranger's reload
	 * of the scenery. Whoever is left becomes host when they leave.
	 *
	 * @returns {number} Player id, or 0 when the room is empty.
	 */
	function hostId() {

		for ( const player of players.values() ) return player.id;

		return 0;

	}

	const room = {

		id,
		config,
		step,

		/** The island seed every client is told to generate. */
		get seed() {

			return seed;

		},
		/** How many fixed steps the room has simulated. */
		get tickCount() {

			return tickCount;

		},
		/** The authoritative terrain, for tests and debugging. */
		get field() {

			return field;

		},
		/** The authoritative tree registry, which every client shares by seed. */
		get trees() {

			return treeRegistry;

		},
		/** Player id of the host, or 0 when empty. */
		get host() {

			return hostId();

		},
		get size() {

			return players.size;

		},
		get full() {

			return players.size >= config.maxPlayers;

		},

		/**
		 * Adds a player, on the lowest free spawn slot, with an unused colour.
		 *
		 * @param {object} [options] Options.
		 * @param {string} [options.name] Display name.
		 * @returns {object|null} The new player record, or null when the room is full.
		 */
		addPlayer( { name } = {} ) {

			if ( players.size >= config.maxPlayers ) return null;

			const id2 = nextId ++;
			const usedSlots = new Set();

			// Lowest free slot index, so a slot is reused once its player leaves.
			for ( const player of players.values() ) usedSlots.add( player.slot );

			let slot = 0;
			while ( usedSlots.has( slot ) ) slot ++;

			const spawn = spawnSlot( field, spawnBase, slot, config );

			const player = {
				id: id2,
				slot,
				name: sanitizeName( name, id2 - 1 ),
				color: pickColor(
					[ ...players.values() ].map( ( other ) => other.color ),
					{ colors: config.colors, random },
				),
				spawn,
				state: createCarState( field, spawn ),
				/** Inputs received but not yet simulated, oldest first. */
				queue: [],
				/** Highest input sequence that has been simulated. */
				ack: 0,
				/** Next sequence this player's client will use. */
				nextSeq: 1,
			};

			players.set( id2, player );

			return player;

		},

		/**
		 * Removes a player, freeing their colour and spawn slot.
		 *
		 * @param {number} id2 Player id.
		 * @returns {boolean} True when a player was removed.
		 */
		removePlayer( id2 ) {

			return players.delete( id2 );

		},

		/**
		 * Renames a player.
		 *
		 * @param {number} id2 Player id.
		 * @param {unknown} value New name, sanitized here rather than by the caller.
		 * @returns {boolean} True when the player exists.
		 */
		setName( id2, value ) {

			const player = players.get( id2 );
			if ( player === undefined ) return false;

			player.name = sanitizeName( value, player.id - 1 );

			return true;

		},

		/**
		 * The roster, as the clients see it.
		 *
		 * @returns {Array<object>} Roster entries.
		 */
		roster() {

			const host = hostId();

			return [ ...players.values() ].map( ( player ) => ( {
				id: player.id,
				name: player.name,
				color: player.color,
				host: player.id === host,
				spawn: player.spawn,
			} ) );

		},

	/**
		 * Queues a batch of inputs for a player.
		 *
		 * Inputs already simulated are dropped (they cannot be applied in order any more), and
		 * the queue is capped: a client that floods the server does not get to fast-forward its
		 * car, it just gets ignored.
		 *
		 * @param {number} id2 Player id.
		 * @param {Array<object>} inputs Input entries, with consecutive sequences.
		 * @returns {number} How many were accepted.
		 */
		queueInputs( id2, inputs ) {

			const player = players.get( id2 );
			if ( player === undefined ) return 0;

			let accepted = 0;

			for ( const entry of inputs ) {

				if ( entry.seq <= player.ack ) continue;                        // already simulated
				if ( player.queue.length >= config.maxInputsPerMessage ) break;  // too far ahead

				player.queue.push( entry );
				if ( entry.seq >= player.nextSeq ) player.nextSeq = entry.seq + 1;
				accepted ++;

			}

			return accepted;

		},

		/**
		 * Puts a player back on their spawn point, and forgets their queued inputs so the reset
		 * cannot be overwritten by inputs that were sent before it.
		 *
		 * @param {number} id2 Player id.
		 * @returns {boolean} True when the player exists.
		 */
		respawn( id2 ) {

			const player = players.get( id2 );
			if ( player === undefined ) return false;

			resetCar( player.state, field, player.spawn );
			player.queue.length = 0;
			player.ack = player.nextSeq - 1;

			return true;

		},

		/**
		 * Gives the room a brand new island, moving everyone onto its spawn slots.
		 *
		 * @param {number} [requestedSeed] Seed to use, for tests and reproducible rooms.
		 * @returns {number} The new seed.
		 */
		newIsland( requestedSeed ) {

			seed = requestedSeed ?? randomSeed( WORLD.maxSeed );
			buildIsland();
			pendingEvents.length = 0;

			return seed;

		},

		/**
		 * Advances the room by exactly one tick.
		 *
		 * One input per player, in order. A player whose queue is empty is left where they are
		 * rather than being stepped with a guess, which is what keeps every client's replay of
		 * its own inputs exact.
		 *
		 * @returns {void}
		 */
		tick() {

			tickCount ++;

			for ( const player of players.values() ) {

				const entry = player.queue.shift();
				if ( entry === undefined ) continue;

				player.ack = entry.seq;

				stepCar( player.state, entry.input, step, field, { collision } );

				for ( const event of player.state.events ) {

					if ( event.type === 'treeBreak' ) {

						pendingEvents.push( {
							type: 'treeBreak',
							tree: event.index,
							x: event.x,
							y: event.y,
							z: event.z,
							radius: event.radius,
						} );

					}

				}

			}

		},

		/**
		 * Takes the world events collected since the last call.
		 *
		 * Drained rather than copied: every client is sent the same batch, so an event is
		 * reported once and then forgotten.
		 *
		 * @returns {Array<object>} Events.
		 */
		drainEvents() {

			const events = pendingEvents;
			pendingEvents = [];

			return events;

		},

		/**
		 * Every car's state, as protocol pose entries.
		 *
		 * @returns {Array<object>} Pose entries, one per player.
		 */
		poses() {

			const out = [];

			for ( const player of players.values() ) out.push( pose( player, player.ack ) );

			return out;

		},

		/**
		 * One player's car state, for tests.
		 *
		 * @param {number} id2 Player id.
		 * @returns {object|undefined} The car state.
		 */
		stateOf( id2 ) {

			return players.get( id2 )?.state;

		},

		/**
		 * The room's players, for tests.
		 *
		 * @returns {Array<object>} Player records.
		 */
		listPlayers() {

			return [ ...players.values() ];

		},

	};

	// Every room starts with an island; the terrain, the trees and the spawn slots all come
	// from the seed, which is what a client is handed on connect.
	buildIsland();

	return room;

}