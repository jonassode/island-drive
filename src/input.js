/**
 * Keyboard input.
 *
 * Arrow keys are the requirement; WASD is accepted as a convenience alias. Arrow keys and
 * space have their default action suppressed so the page never scrolls while driving.
 */

/** Keys whose browser default (page scrolling) must be suppressed. */
const CONSUMED_CODES = new Set( [
	'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
] );

const BINDINGS = {
	up: [ 'ArrowUp', 'KeyW' ],
	down: [ 'ArrowDown', 'KeyS' ],
	left: [ 'ArrowLeft', 'KeyA' ],
	right: [ 'ArrowRight', 'KeyD' ],
};

/**
 * Creates the input tracker.
 *
 * @param {Window} [target] Event target (injectable for tests).
 * @returns {object} Input state and callbacks.
 */
export function createInput( target = window ) {

	const pressed = new Set();
	let onRegenerate = null;
	let onRespawn = null;

	function handleKeyDown( event ) {

		if ( CONSUMED_CODES.has( event.code ) ) event.preventDefault();
		if ( pressed.has( event.code ) ) return;

		pressed.add( event.code );

		if ( event.code === 'KeyR' && onRegenerate !== null ) onRegenerate();
		if ( event.code === 'Space' && onRespawn !== null ) onRespawn();

	}

	function handleKeyUp( event ) {

		pressed.delete( event.code );

	}

	/** Losing focus must release every key, otherwise the car drives off on its own. */
	function releaseAll() {

		pressed.clear();

	}

	target.addEventListener( 'keydown', handleKeyDown );
	target.addEventListener( 'keyup', handleKeyUp );
	target.addEventListener( 'blur', releaseAll );
	target.document?.addEventListener( 'visibilitychange', releaseAll );

	/**
	 * Whether any of the keys bound to an action is held.
	 *
	 * @param {string} action One of up / down / left / right.
	 * @returns {boolean} True when held.
	 */
	function isActive( action ) {

		const keys = BINDINGS[ action ];
		if ( keys === undefined ) return false;
		return keys.some( ( code ) => pressed.has( code ) );

	}

	return {
		get up() {

			return isActive( 'up' );

		},
		get down() {

			return isActive( 'down' );

		},
		get left() {

			return isActive( 'left' );

		},
		get right() {

			return isActive( 'right' );

		},
		/**
		 * Raw check for a specific `KeyboardEvent.code`.
		 *
		 * @param {string} code Key code.
		 * @returns {boolean} True when held.
		 */
		isDown( code ) {

			return pressed.has( code );

		},
		/**
		 * Registers the callback fired when R is pressed.
		 *
		 * @param {Function} callback Callback.
		 * @returns {void}
		 */
		onRegenerate( callback ) {

			onRegenerate = callback;

		},
		/**
		 * Registers the callback fired when space is pressed.
		 *
		 * @param {Function} callback Callback.
		 * @returns {void}
		 */
		onRespawn( callback ) {

			onRespawn = callback;

		},
		releaseAll,
		dispose() {

			target.removeEventListener( 'keydown', handleKeyDown );
			target.removeEventListener( 'keyup', handleKeyUp );
			target.removeEventListener( 'blur', releaseAll );
			target.document?.removeEventListener( 'visibilitychange', releaseAll );

		},
	};

}
