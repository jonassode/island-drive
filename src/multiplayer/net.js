/**
 * The client end of the socket: connect, reconnect, and move frames both ways.
 *
 * Deliberately dumb. It knows the protocol's envelope and nothing about cars: messages are
 * handed to a dispatcher, and the caller sends whatever the protocol builders produce. If the
 * connection cannot be made at all — a static deployment with no server, or `?solo=1` — the
 * game simply stays single player, which is also what keeps `dist/` usable on any web host.
 */

import { MULTIPLAYER } from '../config.js';

/** Connection states the HUD can show. */
export const STATUS = {
	solo: 'solo',
	connecting: 'connecting',
	online: 'online',
	offline: 'offline',
	full: 'full',
};

/**
 * Builds the socket URL for a page.
 *
 * @param {object} options Options.
 * @param {string} options.room Room id.
 * @param {number|null} options.seed Requested island seed.
 * @param {string} options.name Display name.
 * @param {object} config Multiplayer tunables.
 * @returns {string} The URL.
 */
function socketUrl( { room, seed, name }, config ) {

	const query = new URLSearchParams( { room, name } );
	if ( seed !== null ) query.set( 'seed', String( seed ) );

	return `${queryUrlProtocol()}${location.host}${config.path}?${query}`;

}

/**
 * The socket scheme matching the page's own, so an HTTPS page is not blocked from connecting.
 *
 * @returns {string} `ws://` or `wss://`.
 */
function queryUrlProtocol() {

	return location.protocol === 'https:' ? 'wss://' : 'ws://';

}

/**
 * Creates the connection.
 *
 * @param {object} [options] Options.
 * @param {string} options.room Room id to join.
 * @param {number|null} [options.seed] Island seed to ask for, if any.
 * @param {string} [options.name] Display name.
 * @param {(message: object) => void} options.onMessage Frame dispatcher.
 * @param {(status: string) => void} [options.onStatus] Called whenever the state changes.
 * @param {string} [options.url] Override the socket URL, for tests.
 * @param {object} [options.config] Overrides for {@link MULTIPLAYER}.
 * @param {Function} [options.now] Monotonic clock, injectable for tests.
 * @returns {object} The connection handle.
 */
export function createNet( options ) {

	const config = { ...MULTIPLAYER, ...options.config };
	const onMessage = options.onMessage;
	const onStatus = options.onStatus ?? ( () => {} );
	const now = options.now ?? ( () => performance.now() );
	const url = options.url ?? socketUrl( options, config );

	let socket = null;
	let status = STATUS.solo;
	let disposed = false;
	let retryDelay = config.reconnectMinMs;
	let retryTimer = null;
	let watchedAt = 0;
	/** Set when the server says the room is full, so the HUD can say so rather than "offline". */
	let rejected = false;

	/**
	 * Reports a state change, once per change.
	 *
	 * @param {string} next New status.
	 * @returns {void}
	 */
	function setStatus( next ) {

		if ( next === status ) return;

		status = next;
		onStatus( next );

	}

	/**
	 * Opens a socket, arming a retry for whatever happens to it.
	 *
	 * @returns {void}
	 */
	function open() {

		if ( disposed ) return;

		setStatus( STATUS.connecting );

		// Heartbeat and liveness are the server's job; a browser WebSocket cannot send a ping,
		// so instead the client notices that *nothing* has arrived for too long and reconnects.
		const watchdog = setInterval( () => {

			if ( now() - watchedAt > config.staleMs ) {

				clearInterval( watchdog );
				if ( socket !== null ) socket.close();

			}

		}, Math.max( 250, config.staleMs / 3 ) );

		let next;

		try {

			next = new WebSocket( url );

		} catch {

			clearInterval( watchdog );
			scheduleRetry();
			return;

		}

		socket = next;
		watchedAt = now();

		next.addEventListener( 'open', () => {

			retryDelay = config.reconnectMinMs;
			rejected = false;
			watchedAt = now();
			setStatus( STATUS.online );

		} );

		next.addEventListener( 'message', ( event ) => {

			watchedAt = now();

			let message;

			try {

				message = JSON.parse( event.data );

			} catch {

				return; // not ours to understand

			}

			if ( message !== null && message.t === 'full' ) {

				rejected = true;
				setStatus( STATUS.full );

			}

			onMessage( message );

		} );

		next.addEventListener( 'close', () => {

			clearInterval( watchdog );
			if ( socket === next ) socket = null;
			if ( disposed ) return;

			setStatus( rejected ? STATUS.full : STATUS.offline );
			scheduleRetry();

		} );

		next.addEventListener( 'error', () => {

			// An error is always followed by a close, which is where the retry is armed.
			setStatus( rejected ? STATUS.full : STATUS.offline );

		} );

	}

	/**
	 * Arms the next connection attempt, backing off so a server that is down is not hammered.
	 *
	 * @returns {void}
	 */
	function scheduleRetry() {

		if ( disposed || retryTimer !== null ) return;

		retryTimer = setTimeout( () => {

			retryTimer = null;
			retryDelay = Math.min( config.reconnectMaxMs, retryDelay * 2 );
			open();

		}, retryDelay );

	}

	return {
		/** The socket URL this client is talking to, for the HUD and for tests. */
		url,

		/** Current connection state. */
		get status() {

			return status;

		},
		/** True once the socket is open and the server is talking to us. */
		get online() {

			return status === STATUS.online;

		},
		/** Bytes have to be steerable: a message sent while offline is simply dropped. */
		send( message ) {

			if ( socket === null || socket.readyState !== WebSocket.OPEN ) return false;

			socket.send( JSON.stringify( message ) );

			return true;

		},
		/** Starts connecting. */
		connect: open,
		/** Closes for good: no retry, no traffic. */
		dispose() {

			disposed = true;
			if ( retryTimer !== null ) clearTimeout( retryTimer );

			retryTimer = null;

			if ( socket !== null ) socket.close();

			socket = null;
			setStatus( STATUS.solo );

		},
	};

}