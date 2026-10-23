/**
 * Production server: the built game, plus the game socket.
 *
 * `node server/index.js` serves `dist/` and attaches {@link ./socketServer.js} to the same
 * HTTP server, so one process and one port are all a deployment needs. In development there is
 * no separate process at all — the Vite plugin in `vite.config.js` attaches the identical
 * socket server to the dev and preview servers, which is also what lets `npm run smoke` cover
 * multiplayer without any extra setup.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { attachGameServer } from './socketServer.js';

/** Port to listen on. */
const PORT = Number.parseInt( process.env.PORT ?? '4173', 10 );
/** Interface to bind. The default accepts connections from the LAN, which is the point. */
const HOST = process.env.HOST ?? '0.0.0.0';
/** Where the built game lives. */
const ROOT = resolve( process.env.DIST ?? 'dist' );

/** Health check path. `/` would do, but that one needs `dist/` to exist and this does not. */
const HEALTH_PATH = '/healthz';

/**
 * Overrides for the multiplayer tunables, read from the environment.
 *
 * Only a deployment needs these, and only to trade simulation cost for CPU: the server simulates
 * at `MULTIPLAYER.tickRate` and reports the rate it is using in `welcome`, so lowering it here
 * needs no rebuild — the client replays at whatever the server says. Anything unset or
 * unreadable is ignored, which keeps `src/config.js` the source of truth by default.
 *
 * @returns {object} Overrides for the `config` option of {@link attachGameServer}.
 */
function gameConfig() {

	const overrides = {};
	// 60 Hz is the rate the physics was tuned at; below ~10 a moving car stops looking smooth.
	const tickRate = Number.parseInt( process.env.TICK_RATE ?? '', 10 );
	if ( Number.isFinite( tickRate ) && tickRate >= 10 && tickRate <= 60 ) overrides.tickRate = tickRate;

	// Every room holds an island in memory, so this is the knob that bounds the process.
	const maxRooms = Number.parseInt( process.env.MAX_ROOMS ?? '', 10 );
	if ( Number.isFinite( maxRooms ) && maxRooms > 0 ) overrides.maxRooms = maxRooms;

	return overrides;

}

/** Content types for everything Vite emits, plus the odd extra a deployment might add. */
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.glb': 'model/gltf-binary',
	'.wasm': 'application/wasm',
	'.woff2': 'font/woff2',
};

/**
 * Resolves a request path to a file inside `ROOT`, or null when it escapes or does not exist.
 *
 * @param {string} pathname Request path.
 * @returns {Promise<string|null>} Absolute file path, or null.
 */
async function resolveFile( pathname ) {

	// `normalize` collapses any `..` segments, and the prefix check then rejects anything that
	// still points outside the build directory.
	const candidate = resolve( ROOT, `.${pathname}` );
	if ( candidate !== ROOT && candidate.startsWith( `${ROOT}${process.platform === 'win32' ? '\\' : '/'}` ) === false ) return null;

	try {

		const info = await stat( candidate );
		if ( info.isFile() ) return candidate;

	} catch {

		return null;

	}

	return null;

}

/**
 * Serves one static request, falling back to `index.html` so deep links work.
 *
 * @param {import('http').IncomingMessage} request Request.
 * @param {import('http').ServerResponse} response Response.
 * @returns {Promise<void>} Resolves when the response has been sent.
 */
async function serveStatic( request, response ) {

	const pathname = decodeURIComponent( new URL( request.url, 'http://localhost' ).pathname );
	const isIndex = pathname === '/' || pathname === '/index.html';

	let file = isIndex ? await resolveFile( '/index.html' ) : await resolveFile( pathname );
	if ( file === null ) file = await resolveFile( '/index.html' ); // deep link / unknown route

	if ( file === null ) {

		response.writeHead( 404, { 'content-type': 'text/plain; charset=utf-8' } );
		response.end( 'not built yet — run `npm run build`\n' );
		return;

	}

	const body = await readFile( file );

	response.writeHead( 200, {
		'content-type': MIME[ extname( file ) ] ?? 'application/octet-stream',
		// The bundle is content hashed, the shell is not; this keeps a reload from serving a
		// stale index while the assets update.
		'cache-control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
	} );
	response.end( body );

}

const server = createServer( ( request, response ) => {

	// Answered before anything touches the filesystem, because a platform health check runs
	// while the service is still starting — including before a redeploy's `dist/` is in place.
	// Split rather than parsed: this is the one request path that must not be able to throw.
	if ( ( request.url ?? '' ).split( '?' )[ 0 ] === HEALTH_PATH ) {

		response.writeHead( 200, { 'content-type': 'text/plain; charset=utf-8' } );
		response.end( 'ok\n' );
		return;

	}

	serveStatic( request, response ).catch( () => {

		response.writeHead( 500, { 'content-type': 'text/plain; charset=utf-8' } );
		response.end( 'internal error\n' );

	} );

} );

const overrides = gameConfig();
const game = attachGameServer( server, {
	config: overrides,
	log: ( message ) => console.log( `[game] ${message}` ),
} );

server.listen( PORT, HOST, () => {

	// A deployment that set one of these would otherwise have no way to tell that it took effect.
	if ( overrides.tickRate !== undefined ) console.log( `[game] TICK_RATE: simulating at ${overrides.tickRate} Hz` );
	if ( overrides.maxRooms !== undefined ) console.log( `[game] MAX_ROOMS: at most ${overrides.maxRooms} rooms` );

	console.log( `Island Drive on http://localhost:${PORT}  (socket ${game.url}, ${ROOT})` );

} );

/** Closing the server takes the sockets and tick loops with it. */
function shutdown() {

	game.dispose();
	server.close( () => process.exit( 0 ) );
	// A client that never closes its socket must not hold the process open.
	setTimeout( () => process.exit( 0 ), 1000 ).unref();

}

process.on( 'SIGINT', shutdown );
process.on( 'SIGTERM', shutdown );