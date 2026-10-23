import { defineConfig } from 'vitest/config';
import { attachGameServer } from './server/socketServer.js';

/**
 * Attaches the multiplayer socket server to Vite's own dev and preview servers.
 *
 * Doing it here rather than in a separate process means `npm run dev` and `npm run preview`
 * (which is what the smoke test drives) are multiplayer with no extra step, while `npm run
 * build` still emits a plain static bundle that works on its own — a page whose socket never
 * connects simply stays single player.
 *
 * @returns {import('vite').Plugin} The plugin.
 */
function multiplayer() {

	/** @param {import('http').Server|null} httpServer */
	function attach( httpServer, log ) {

		// Vitest creates a middleware-mode Vite server with no HTTP server of its own.
		if ( httpServer === null ) return;

		const game = attachGameServer( httpServer, { log } );

		httpServer.on( 'close', () => game.dispose() );
		log( `multiplayer socket on ${game.url}` );

	}

	return {
		name: 'island-drive-multiplayer',
		configureServer( server ) {

			attach( server.httpServer, server.config.logger.info.bind( server.config.logger ) );

		},
		configurePreviewServer( server ) {

			attach( server.httpServer, server.config.logger.info.bind( server.config.logger ) );

		},
	};

}

export default defineConfig( {
	// Relative base so `dist/` can be served from any sub-directory.
	base: './',
	server: {
		open: true,
	},
	build: {
		outDir: 'dist',
	},
	plugins: [ multiplayer() ],
	test: {
		// The heightfield, car physics, props and the multiplayer protocol/room are pure
		// modules: they need no DOM/WebGL.
		environment: 'node',
		include: [ 'tests/**/*.test.js' ],
	},
} );
