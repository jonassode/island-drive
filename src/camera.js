/**
 * Damped chase camera.
 *
 * The offset is built from the car's *heading only* (not its full orientation), so the
 * horizon stays level while the car pitches and rolls over the terrain, which is far
 * easier to read while driving.
 */

import { Vector3 } from 'three';
import { CAMERA } from './config.js';

/**
 * Creates the chase camera controller.
 *
 * @param {object} camera The `THREE.PerspectiveCamera` to drive.
 * @param {object} heightField Terrain, so the camera can be kept above ground level.
 * @param {object} [config] Camera tunables.
 * @returns {{ update: (dt: number, carState: object, carObject: object) => void, snap: () => void }}
 */
export function createChaseCamera( camera, heightField, config = CAMERA ) {

	const desired = new Vector3();
	const targetLook = new Vector3();
	const currentLook = new Vector3();
	let ready = false;

	/**
	 * Places the camera behind the car, without smoothing.
	 *
	 * @returns {void}
	 */
	function snap() {

		ready = false;

	}

	/**
	 * Advances the camera.
	 *
	 * @param {number} dt Time step in seconds.
	 * @param {object} carState Physics state (position + heading).
	 * @param {object} carObject The car's `Object3D`.
	 * @returns {void}
	 */
	function update( dt, carState, carObject ) {

		const forwardX = Math.sin( carState.heading );
		const forwardZ = Math.cos( carState.heading );
		const carX = carObject.position.x;
		const carZ = carObject.position.z;

		const behindX = carX - forwardX * config.distance;
		const behindZ = carZ - forwardZ * config.distance;
		const groundY = heightField.heightAt( behindX, behindZ );

		desired.set(
			behindX,
			Math.max( carObject.position.y + config.height, groundY + config.groundClearance ),
			behindZ,
		);

		targetLook.set(
			carX + forwardX * config.lookAhead,
			carObject.position.y + config.lookHeight,
			carZ + forwardZ * config.lookAhead,
		);

		if ( ready === false ) {

			camera.position.copy( desired );
			currentLook.copy( targetLook );
			ready = true;

		} else {

			// Frame rate independent damping.
			const alpha = 1 - Math.exp( - config.damp * dt );
			camera.position.lerp( desired, alpha );
			currentLook.lerp( targetLook, alpha );

		}

		camera.lookAt( currentLook );

	}

	return { update, snap };

}
