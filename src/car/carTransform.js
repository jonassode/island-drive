/**
 * Per car mesh transform: physics state in, wheels and body posed out.
 *
 * Extracted from the game loop so the *same* code poses the local car and every remote one:
 * the terrain fit, the levelling while airborne, the visual suspension and the wheel roll are
 * identical for all of them, and duplicating them per car is exactly how two cars end up
 * disagreeing about how a hill looks.
 *
 * The levelling while airborne is incremental (the body eases towards level rather than
 * snapping to it), so it needs its own state per car — hence the factory, and why one shared
 * scratch vector would be wrong here.
 */

import { Quaternion, Vector3 } from 'three';
import { CAR } from '../config.js';

const UP = new Vector3( 0, 1, 0 );

/**
 * Creates the transform driver for one car.
 *
 * @param {object} car A car as returned by `buildCar()`.
 * @param {object} [config] Vehicle tunables.
 * @returns {{ apply: (state: object, pose: object, dt: number) => void }} The driver.
 */
export function createCarTransform( car, config = CAR ) {

	/** The body's up vector, kept between calls: while airborne it eases towards `UP`. */
	const up = new Vector3( 0, 1, 0 );
	const tiltQuat = new Quaternion();
	const yawQuat = new Quaternion();

	/**
	 * Poses the car from its physics state.
	 *
	 * @param {object} state Car physics state (position, heading, speed, flags).
	 * @param {object} pose Terrain fit from `fitCarToGround()`. `up` may be a `Vector3`.
	 * @param {number} dt Time step, used for the wheel roll rate.
	 * @returns {void}
	 */
	function apply( state, pose, dt ) {

		if ( state.airborne ) {

			const level = Math.min( 1, config.airLevelRate * dt );
			up.lerp( UP, level ).normalize();

		} else {

			up.copy( pose.up );

		}

		car.group.position.set( state.x, state.y + config.rideHeight, state.z );

		tiltQuat.setFromUnitVectors( UP, up );
		yawQuat.setFromAxisAngle( UP, state.heading );
		car.group.quaternion.multiplyQuaternions( tiltQuat, yawQuat );

		// Visual suspension: the body keeps the fitted plane, and each wheel reaches for the
		// ground under it, so bumps do not leave wheels hanging in the air.
		for ( let i = 0; i < car.suspension.length; i ++ ) {

			const node = car.suspension[ i ];

			node.node.position.y = state.airborne || state.inWater
				// Nothing to reach for: let the wheels hang at full droop.
				? node.baseY - config.suspensionTravel
				: node.baseY + pose.travel[ i ];

		}

		const roll = dt * ( state.speed / config.wheelRadius );
		for ( const wheel of car.wheels ) wheel.rotation.x += roll;
		for ( const pivot of car.steerPivots ) pivot.rotation.y = state.steerAngle;

	}

	/** Drops the accumulated tilt, so a car (re)appearing does not ease in from the last one. */
	function reset() {

		up.copy( UP );

	}

	return { apply, reset };

}