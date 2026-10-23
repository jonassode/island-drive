/**
 * Client side prediction: run your own car, then let the server correct it invisibly.
 *
 * The client steps the *same* simulation as the server, at the same fixed rate, with the same
 * island and the same tree list — so as long as it replays the same inputs, it gets the same
 * answer. Three things follow from that:
 *
 * 1. Every tick, the local input is recorded against a sequence number.
 * 2. When a snapshot arrives, the car is rolled back to the server's state, the inputs the
 *    server has not acknowledged yet are replayed, and the client carries on.
 * 3. The difference that *does* remain (usually nothing, occasionally a rounding of the
 *    server's timing) is not applied to the car directly. It is added to `renderState` and
 *    decays over a few frames, so a correction is a slight slide rather than a jolt.
 *
 * Everything here is deliberately free of three.js and the DOM: the caller hands in the step
 * function, which is `stepCar()` in the game and a stub in the tests.
 */

import { MULTIPLAYER } from '../config.js';
import { writePoseToState } from './protocol.js';

/**
 * Creates the prediction state for the local car.
 *
 * @param {object} [options] Options.
 * @param {object} [options.config] Overrides for {@link MULTIPLAYER}.
 * @returns {object} The prediction state.
 */
export function createPrediction( options = {} ) {

	const config = { ...MULTIPLAYER, ...options.config };

	/** Inputs simulated locally but not yet acknowledged, oldest first. */
	const history = [];
	/** Inputs not yet sent to the server, oldest first. */
	const outbox = [];
	let nextSeq = 1;

	/**
	 * Where the car is drawn: the simulated state plus the correction still to be smoothed
	 * away. A zero correction means it is exactly the simulated state.
	 */
	const renderState = {
		x: 0, y: 0, z: 0, heading: 0, speed: 0, steerAngle: 0, airborne: false, inWater: false,
	};

	const error = { x: 0, y: 0, z: 0 };

	/** The predicted state before a rollback, so the correction can be measured. */
	const before = { x: 0, y: 0, z: 0 };

	/** How many rollbacks were too large to smooth, for the HUD and for tests. */
	let snaps = 0;

	return {
		renderState,
		/** Correction still to be smoothed away, in world units. */
		get errorMagnitude() {

			return Math.hypot( error.x, error.y, error.z );

		},
		/** Inputs awaiting an acknowledgement, i.e. how far ahead of the server we are. */
		get pending() {

			return history.length;

		},
		/** How many corrections were too large to smooth and were snapped instead. */
		get snaps() {

			return snaps;

		},
		/** The sequence the next simulated tick will use. */
		get nextSeq() {

			return nextSeq;

		},

		/**
		 * Records the input about to be simulated, and queues it to be sent.
		 *
		 * @param {{up: boolean, down: boolean, left: boolean, right: boolean}} input Input.
		 * @returns {object} The recorded entry, with its sequence number.
		 */
		record( input ) {

			const entry = {
				seq: nextSeq,
				input: {
					up: input.up, down: input.down, left: input.left, right: input.right,
				},
			};

			nextSeq ++;
			history.push( entry );
			outbox.push( entry );

			// Safety valve: a client this far ahead of the server has a badly lagging link, and
			// replaying everything is worse than letting the acknowledgement win. The oldest
			// inputs are dropped, and the next snapshot simply corrects a little more.
			while ( history.length > config.replayMaxTicks ) history.shift();
			while ( outbox.length > config.maxInputsPerMessage ) outbox.shift();

			return entry;

		},

		/**
		 * Takes the inputs waiting to be sent, up to a batch.
		 *
		 * @param {number} [limit] Largest batch to take.
		 * @returns {{base: number, inputs: Array<Array<number>>}|null} The batch, or null when
		 *   there is nothing to send.
		 */
		takeOutbox( limit = config.inputBatch ) {

			if ( outbox.length === 0 ) return null;

			const count = Math.min( limit, outbox.length );
			const taken = outbox.splice( 0, count );

			return {
				base: taken[ 0 ].seq,
				inputs: taken.map( ( entry ) => [
					entry.input.up ? 1 : 0,
					entry.input.down ? 1 : 0,
					entry.input.left ? 1 : 0,
					entry.input.right ? 1 : 0,
				] ),
			};

		},

		/**
		 * Rolls the car back to the server's state and replays the unacknowledged inputs.
		 *
		 * @param {object} state Local car state, mutated.
		 * @param {object} entry The pose entry for this player from a snapshot.
		 * @param {(input: object) => void} applyStep Steps the car once with one input. This is
		 *   `stepCar()` bound to the local terrain, so replaying is exactly re-simulating.
		 * @returns {{snapped: boolean, distance: number}} What the correction looked like.
		 */
		reconcile( state, entry, applyStep ) {

			while ( history.length > 0 && history[ 0 ].seq <= entry.ack ) history.shift();

			before.x = state.x;
			before.y = state.y;
			before.z = state.z;

			writePoseToState( state, entry );

			for ( let i = 0; i < history.length; i ++ ) applyStep( history[ i ].input );

			// The correction that remains, expressed as "where the car should be drawn, relative
			// to where it now is": the old correction carried over, plus the rollback.
			error.x = before.x + error.x - state.x;
			error.y = before.y + error.y - state.y;
			error.z = before.z + error.z - state.z;

			const distance = Math.hypot( error.x, error.y, error.z );

			if ( distance > config.snapDistance ) {

				// Too far to slide: take the correction at once. This is a real disagreement
				// (a respawn, a new island, a long stall) rather than the tail of a replay.
				error.x = 0;
				error.y = 0;
				error.z = 0;
				snaps ++;

				return { snapped: true, distance };

			}

			return { snapped: false, distance };

		},

		/**
		 * Advances the correction fade and refreshes `renderState`.
		 *
		 * Called once per rendered frame rather than once per tick: the correction is a display
		 * concern, and the simulation never sees it.
		 *
		 * @param {number} dt Time since the last frame, in seconds.
		 * @param {object} state The simulated local car state.
		 * @returns {void}
		 */
		update( dt, state ) {

			const decay = Math.exp( - config.errorDecay * Math.max( 0, dt ) );
			error.x *= decay;
			error.y *= decay;
			error.z *= decay;

			renderState.x = state.x + error.x;
			renderState.y = state.y + error.y;
			renderState.z = state.z + error.z;
			renderState.heading = state.heading;
			renderState.speed = state.speed;
			renderState.steerAngle = state.steerAngle;
			renderState.airborne = state.airborne;
			renderState.inWater = state.inWater;

		},

		/**
		 * Forgets the predicted and unsent inputs, and drops any correction.
		 *
		 * Used when the local state is reset outside the tick loop — a respawn, a new island, a
		 * reconnect — where replaying old inputs would undo the reset.
		 *
		 * @returns {void}
		 */
		reset() {

			history.length = 0;
			outbox.length = 0;
			error.x = 0;
			error.y = 0;
			error.z = 0;

		},

	};

}