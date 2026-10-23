/**
 * The wire protocol: what a client and the server say to each other.
 *
 * Plain JSON over one WebSocket. The island is *not* in here — every client regenerates it
 * from the room's seed — so the only things that ever cross the wire are a player's inputs,
 * the server's snapshot of where everyone is, and the odd room event. A snapshot is small
 * enough (a couple of hundred bytes per car, twenty times a second) that readability is worth
 * more than a binary format.
 *
 * This module owns both directions, and every parser is defensive: the server runs whatever
 * unknown clients send it, so a malformed frame must come back as `null` rather than an
 * exception.
 */

import { MULTIPLAYER } from '../config.js';

/** Car state flags, packed into one number in the pose. */
export const FLAG = {
	airborne: 1,
	inWater: 2,
	onLand: 4,
};

// ------------------------------------------------------------------ server -> client

/**
 * The first message: who you are, which island, and who else is here.
 *
 * The rates are the *server's*, not the client's build of `MULTIPLAYER` — a client has to
 * simulate at the rate the server does for prediction to line up, so it is told rather than
 * assumed.
 *
 * @param {object} options Options.
 * @param {string} options.room Room id.
 * @param {number} options.you Your player id.
 * @param {number} options.seed Island seed for the whole room.
 * @param {Array<object>} options.players Roster, including you.
 * @param {number} [options.tickRate] Simulation frequency of the server, in Hz.
 * @param {number} [options.snapshotRate] Snapshot frequency of the server, in Hz.
 * @returns {object} The message.
 */
export function welcome( { room, you, seed, players, tickRate, snapshotRate } ) {

	return {
		t: 'welcome',
		room,
		you,
		seed,
		tickRate: tickRate ?? MULTIPLAYER.tickRate,
		snapshotRate: snapshotRate ?? MULTIPLAYER.snapshotRate,
		players,
	};

}

/**
 * Somebody joined.
 *
 * @param {object} player Roster entry.
 * @returns {object} The message.
 */
export function join( player ) {

	return { t: 'join', player };

}

/**
 * Somebody left.
 *
 * @param {number} id Player id.
 * @returns {object} The message.
 */
export function leave( id ) {

	return { t: 'leave', id };

}

/**
 * The room's island changed (the host asked for a new one), so every client rebuilds and
 * respawns.
 *
 * @param {object} options Options.
 * @param {number} options.seed The new seed.
 * @param {Array<object>} options.players Roster, with fresh spawn slots.
 * @returns {object} The message.
 */
export function room( { seed, players } ) {

	return { t: 'room', seed, players };

}

/**
 * Where everyone is, and what they did since the last snapshot.
 *
 * @param {number} tick The server tick this snapshot was taken at.
 * @param {Array<object>} poses Pose entries, as built by {@link pose}.
 * @param {Array<object>} [events] World events, e.g. a smashed tree.
 * @returns {object} The message.
 */
export function snapshot( tick, poses, events = [] ) {

	return { t: 'snapshot', tick, p: poses, e: events };

}

/**
 * The room is full.
 *
 * @param {number} maxPlayers Capacity of the room.
 * @returns {object} The message.
 */
export function full( maxPlayers ) {

	return { t: 'full', max: maxPlayers };

}

/**
 * Something went wrong with your message. Sent instead of dropping it silently, so a client
 * bug is visible rather than mysterious.
 *
 * @param {string} message What was wrong.
 * @returns {object} The message.
 */
export function error( message ) {

	return { t: 'error', m: message };

}

/**
 * A car's position at one tick.
 *
 * Every field of the simulation that survives a step is here, not just the position: the
 * client rolls its own car back to this state and replays the inputs the server has not
 * acknowledged yet, so a missing field would be a divergence that never heals.
 *
 * @param {object} player Room player record.
 * @param {number} ack Highest input sequence the server has simulated for this player.
 * @returns {object} The pose entry.
 */
export function pose( player, ack ) {

	const state = player.state;

	let flags = 0;
	if ( state.airborne ) flags |= FLAG.airborne;
	if ( state.inWater ) flags |= FLAG.inWater;
	if ( state.onLand ) flags |= FLAG.onLand;

	return {
		id: player.id,
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
		flags,
		ack,
	};

}

/**
 * Reads the flags of a pose back out.
 *
 * @param {number} flags Packed flags.
 * @returns {{airborne: boolean, inWater: boolean, onLand: boolean}} Flag set.
 */
export function readFlags( flags ) {

	return {
		airborne: ( flags & FLAG.airborne ) !== 0,
		inWater: ( flags & FLAG.inWater ) !== 0,
		onLand: ( flags & FLAG.onLand ) !== 0,
	};

}

// ------------------------------------------------------------------ client -> server

/**
 * A batch of inputs, one per client tick.
 *
 * `base` is the sequence of the *first* entry, so the server can label each one as it applies
 * it. Inputs are the only thing a client is trusted about, and they are four booleans.
 *
 * @param {number} base Sequence of the first input in the batch.
 * @param {Array<Array<number>>} inputs `[up, down, left, right]` per tick, as 0 or 1.
 * @returns {object} The message.
 */
export function input( base, inputs ) {

	return { t: 'input', base, i: inputs };

}

/** Puts the sender's own car back on its spawn point. */
export const respawn = () => ( { t: 'respawn' } );

/** Asks the room for a brand new island (only the host may do this). */
export const newIsland = () => ( { t: 'newIsland' } );

/**
 * Renames the sender.
 *
 * @param {string} value New name.
 * @returns {object} The message.
 */
export function name( value ) {

	return { t: 'name', v: value };

}

/**
 * Trims a display name down to something safe to broadcast.
 *
 * @param {unknown} value Raw name from the client.
 * @param {number} [fallbackId] Player id, used to invent a name when there is none.
 * @returns {string} The sanitized name.
 */
export function sanitizeName( value, fallbackId = 0 ) {

	if ( typeof value !== 'string' ) return `Driver ${fallbackId + 1}`;

	// Control characters and whitespace runs first, then the length cap.
	const cleaned = value.replace( /[\p{Cc}\p{Cf}]/gu, '' ).replace( /\s+/g, ' ' ).trim();
	if ( cleaned === '' ) return `Driver ${fallbackId + 1}`;

	return cleaned.slice( 0, MULTIPLAYER.nameMaxLength );

}

/**
 * Decodes a frame from a client.
 *
 * @param {string|Uint8Array} raw Frame payload.
 * @returns {object|null} The message, or null when it is not one we understand.
 */
export function decode( raw ) {

	let text;

	if ( typeof raw === 'string' ) text = raw;
	else if ( raw instanceof Uint8Array ) text = new TextDecoder().decode( raw );
	else return null;

	if ( text.length > 4096 ) return null;

	let message;

	try {

		message = JSON.parse( text );

	} catch {

		return null;

	}

	if ( message === null || typeof message !== 'object' ) return null;
	if ( typeof message.t !== 'string' ) return null;

	return message;

}

/**
 * Writes an authoritative pose onto a car state.
 *
 * The rollback half of client side prediction: everything `stepCar()` carries between ticks is
 * copied, so a replay from this state produces exactly what the server produced.
 *
 * @param {object} state Car state to overwrite.
 * @param {object} entry Pose entry from a snapshot.
 * @returns {object} The same state object.
 */
export function writePoseToState( state, entry ) {

	state.x = entry.x;
	state.y = entry.y;
	state.z = entry.z;
	state.heading = entry.heading;
	state.speed = entry.speed;
	state.steerAngle = entry.steer;
	state.verticalSpeed = entry.vy;
	state.groundSpeed = entry.groundSpeed;
	state.groundY = entry.groundY;
	state.waterTime = entry.waterTime;
	state.safeTimer = entry.safeTimer;
	state.lastSafe.x = entry.lastSafeX;
	state.lastSafe.z = entry.lastSafeZ;
	state.lastSafe.heading = entry.lastSafeH;

	const flags = readFlags( entry.flags );
	state.airborne = flags.airborne;
	state.inWater = flags.inWater;
	state.onLand = flags.onLand;
	state.bumped = false;
	state.blocked = false;
	state.events.length = 0;

	return state;

}

/**
 * Reads a batch of inputs, keeping only what is well formed.
 *
 * The batch is validated as a whole: the sequence numbers have to run consecutively from
 * `base`, because the server hands them back as the acknowledgement the client rolls back to.
 * Anything longer than `maxInputsPerMessage` is truncated — a burst that big means a client is
 * far ahead, and applying it would teleport the car.
 *
 * @param {object} message A decoded frame.
 * @returns {{base: number, inputs: Array<{seq: number, input: object}>}|null} The batch, or
 *   null when unusable.
 */
export function readInputBatch( message ) {

	const base = message.base;

	if ( Number.isInteger( base ) === false || base < 0 ) return null;
	if ( Array.isArray( message.i ) === false || message.i.length === 0 ) return null;

	const limit = Math.min( message.i.length, MULTIPLAYER.maxInputsPerMessage );
	const inputs = [];

	for ( let i = 0; i < limit; i ++ ) {

		const raw = message.i[ i ];

		if ( Array.isArray( raw ) === false || raw.length < 4 ) return null;

		inputs.push( {
			seq: base + i,
			input: {
				up: raw[ 0 ] === 1,
				down: raw[ 1 ] === 1,
				left: raw[ 2 ] === 1,
				right: raw[ 3 ] === 1,
			},
		} );

	}

	return { base, inputs };

}