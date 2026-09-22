/**
 * The DOM overlay: speed readout, island seed, status hints and the loading curtain.
 *
 * Every setter early-returns when the value has not changed, so the render loop never
 * thrashes the DOM.
 */

/**
 * Creates the HUD controller.
 *
 * @param {Document} [root] Document to query (injectable for tests).
 * @returns {object} HUD setters.
 */
export function createHud( root = document ) {

	const speedValue = root.getElementById( 'speed-value' );
	const seedLabel = root.getElementById( 'seed' );
	const statusLabel = root.getElementById( 'status' );
	const airborneLabel = root.getElementById( 'airborne' );
	const loading = root.getElementById( 'loading' );

	let lastSpeed = null;
	let lastSeed = null;
	let lastStatus = null;
	let lastAirborne = null;

	return {
		/**
		 * Updates the speedometer.
		 *
		 * @param {number} kmh Speed in km/h.
		 * @returns {void}
		 */
		setSpeed( kmh ) {

			const rounded = Math.round( kmh );
			if ( rounded === lastSpeed ) return;

			lastSpeed = rounded;
			if ( speedValue !== null ) speedValue.textContent = String( rounded );

		},
		/**
		 * Shows the current island seed.
		 *
		 * @param {number} seed Island seed.
		 * @returns {void}
		 */
		setSeed( seed ) {

			if ( seed === lastSeed ) return;

			lastSeed = seed;
			if ( seedLabel !== null ) seedLabel.textContent = `seed ${seed}`;

		},
		/**
		 * Shows a transient hint (e.g. that the car met the sea).
		 *
		 * @param {string} text Message, empty to clear.
		 * @returns {void}
		 */
		setStatus( text ) {

			if ( text === lastStatus ) return;

			lastStatus = text;
			if ( statusLabel !== null ) statusLabel.textContent = text;

		},
		/**
		 * Shows or hides the airborne indicator.
		 *
		 * @param {boolean} airborne Whether the car is off the ground.
		 * @returns {void}
		 */
		setAirborne( airborne ) {

			if ( airborne === lastAirborne ) return;

			lastAirborne = airborne;
			if ( airborneLabel !== null ) airborneLabel.classList.toggle( 'on', airborne );

		},
		/** Hides the loading curtain once the first frame is on screen. */
		setReady() {

			if ( loading !== null ) loading.classList.add( 'hidden' );

		},
	};

}
