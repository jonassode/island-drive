/**
 * Car colours for a multiplayer room.
 *
 * Each player gets a random paint that nobody else in the room is using, so the palette is
 * exactly `MULTIPLAYER.maxPlayers` long and every car in a full room is a different colour.
 * Nothing is persisted: colours are handed out per connection and released when a player
 * leaves.
 *
 * Pure (no DOM, no sockets), so it runs headless under Vitest and on the server.
 */

import { MULTIPLAYER } from '../config.js';

/**
 * Picks a random colour that is not already taken.
 *
 * @param {Array<number>} taken Colours in use, in this room.
 * @param {object} [options] Options.
 * @param {Array<number>} [options.colors] Palette to draw from.
 * @param {() => number} [options.random] Random source, injectable for tests.
 * @returns {number} Hex colour.
 */
export function pickColor( taken, options = {} ) {

	const colors = options.colors ?? MULTIPLAYER.colors;
	const random = options.random ?? Math.random;

	if ( colors.length === 0 ) return 0xd93b2b;

	// A set, because a room of eight players asks this question eight times per join.
	const used = new Set( taken );
	const free = colors.filter( ( color ) => used.has( color ) === false );

	// A full room (or duplicate entries in `taken`) falls back to the whole palette rather
	// than failing to hand out a colour at all.
	const pool = free.length > 0 ? free : colors;

	return pool[ Math.min( pool.length - 1, Math.floor( random() * pool.length ) ) ];

}