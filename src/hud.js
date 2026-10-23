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
	const connectionLabel = root.getElementById( 'connection' );
	const playersList = root.getElementById( 'players' );
	const loading = root.getElementById( 'loading' );

	let lastSpeed = null;
	let lastSeed = null;
	let lastStatus = null;
	let lastAirborne = null;
	let lastConnection = null;
	let lastRoster = null;
	let lastSeedText = null;

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
		 * Shows the current island seed, and what the island belongs to.
		 *
		 * @param {number} seed Island seed.
		 * @param {string} [suffix] Extra text, e.g. the room it is shared with.
		 * @returns {void}
		 */
		setSeed( seed, suffix = '' ) {

			const text = `seed ${seed}${suffix}`;
			if ( text === lastSeedText ) return;

			lastSeedText = text;
			lastSeed = seed;
			if ( seedLabel !== null ) seedLabel.textContent = text;

		},
		/**
		 * Shows the connection state, or that this is a solo game.
		 *
		 * @param {string} text Line to show.
		 * @returns {void}
		 */
		setConnection( text ) {

			if ( text === lastConnection ) return;

			lastConnection = text;
			if ( connectionLabel !== null ) connectionLabel.textContent = text;

		},
		/**
		 * Lists the cars in the room.
		 *
		 * @param {Array<{id: number, name: string, color: number, host: boolean}>} players Roster.
		 * @param {number} you Local player id, so your own row can be marked.
		 * @returns {void}
		 */
		setPlayers( players, you ) {

			const signature =
				`${you}#${players.map( ( player ) => `${player.id}:${player.name}` ).join( '|' )}`;

			if ( signature === lastRoster ) return;

			lastRoster = signature;

			if ( playersList === null ) return;

			playersList.textContent = '';

			for ( const player of players ) {

				const item = root.createElement( 'li' );

				const swatch = root.createElement( 'i' );
				swatch.style.background = `#${( player.color >>> 0 ).toString( 16 ).padStart( 6, '0' )}`;
				item.appendChild( swatch );

				const label = root.createElement( 'span' );
				label.textContent = player.id === you ? `${player.name} (you)` : player.name;
				if ( player.host ) label.textContent += ' ★';
				item.appendChild( label );

				if ( player.id === you ) item.classList.add( 'you' );

				playersList.appendChild( item );

			}

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
