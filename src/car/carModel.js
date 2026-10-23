/**
 * The car, built from primitive geometries.
 *
 * No binary asset is needed: a `Group` holds the chassis parts and four wheel groups, so
 * the wheels can spin and the front pair can steer independently of the body.
 *
 * Contract used by the rest of the app:
 * - `group` carries the world transform (position + terrain aligned orientation).
 * - `wheels` is rotated about X to roll; `steerPivots` is rotated about Y to steer.
 */

import {
	BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial,
} from 'three';
import { CAR, COLORS } from '../config.js';

const BODY = { width: 1.9, height: 0.62, length: 4.2 };
const WHEEL_WIDTH = 0.34;

/**
 * Creates one wheel: a rubber cylinder with a brighter hub cap, axle along local X.
 *
 * @param {MeshStandardMaterial} rubber Tyre material.
 * @param {MeshStandardMaterial} hub Hub material.
 * @returns {Group} The wheel group.
 */
function createWheel( rubber, hub ) {

	const radius = CAR.wheelRadius;
	const wheel = new Group();
	wheel.name = 'wheel';

	const tyre = new Mesh( new CylinderGeometry( radius, radius, WHEEL_WIDTH, 18 ), rubber );
	tyre.rotation.z = Math.PI / 2; // cylinder axis Y -> X, so rotation.x rolls the wheel
	tyre.castShadow = true;
	wheel.add( tyre );

	const cap = new Mesh( new CylinderGeometry( radius * 0.58, radius * 0.58, WHEEL_WIDTH + 0.02, 12 ), hub );
	cap.rotation.z = Math.PI / 2;
	cap.castShadow = true;
	wheel.add( cap );

	return wheel;

}

/**
 * Builds the car.
 *
 * The paint is the only per-owner difference: in a multiplayer room every player gets their
 * own colour, and this is where it is applied. Everything else is shared geometry.
 *
 * @param {object} [options] Options.
 * @param {number} [options.color] Paint colour of the body, in place of `COLORS.carPaint`.
 * @returns {{ group: Group, chassis: Group, wheels: Group[], steerPivots: Group[],
 *   suspension: Array<object>, wheelOffsets: Array<object>, dispose: () => void }} The car parts.
 */
export function buildCar( options = {} ) {

	const group = new Group();
	group.name = 'car';

	const chassis = new Group();
	chassis.name = 'car-chassis';
	group.add( chassis );

	const geometries = [];
	const materials = [];

	/**
	 * Registers a mesh on the chassis.
	 *
	 * @param {object} geometry Geometry to use.
	 * @param {object} material Material to use.
	 * @param {number} x Local x.
	 * @param {number} y Local y.
	 * @param {number} z Local z.
	 * @returns {Mesh} The created mesh.
	 */
	function addPart( geometry, material, x, y, z ) {

		const mesh = new Mesh( geometry, material );
		mesh.position.set( x, y, z );
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		chassis.add( mesh );
		geometries.push( geometry );
		return mesh;

	}

	const paint = new MeshStandardMaterial( {
		color: options.color ?? COLORS.carPaint, metalness: 0.5, roughness: 0.32,
	} );
	const trim = new MeshStandardMaterial( { color: COLORS.carTrim, metalness: 0.65, roughness: 0.45 } );
	const glass = new MeshStandardMaterial( { color: COLORS.carGlass, metalness: 0.2, roughness: 0.08 } );
	const rubber = new MeshStandardMaterial( { color: COLORS.wheel, metalness: 0.05, roughness: 0.95 } );
	const hub = new MeshStandardMaterial( { color: COLORS.hub, metalness: 0.9, roughness: 0.25 } );
	const headlight = new MeshStandardMaterial( {
		color: 0xfff6d5, emissive: 0xffe8a3, emissiveIntensity: 1.4, roughness: 0.25,
	} );
	const taillight = new MeshStandardMaterial( {
		color: 0x6b0d0d, emissive: 0xff2b2b, emissiveIntensity: 0.9, roughness: 0.4,
	} );

	materials.push( paint, trim, glass, rubber, hub, headlight, taillight );

	// Main hull, sill and the greenhouse.
	addPart( new BoxGeometry( BODY.width, BODY.height, BODY.length ), paint, 0, 0.72, 0 );
	addPart( new BoxGeometry( BODY.width + 0.1, 0.22, BODY.length + 0.1 ), trim, 0, 0.48, 0 );
	addPart( new BoxGeometry( 1.62, 0.55, 1.9 ), glass, 0, 1.28, - 0.25 );
	addPart( new BoxGeometry( 1.5, 0.12, 1.7 ), paint, 0, 1.58, - 0.28 );

	// Lights and grille.
	addPart( new BoxGeometry( 0.42, 0.18, 0.12 ), headlight, 0.62, 0.86, 2.1 );
	addPart( new BoxGeometry( 0.42, 0.18, 0.12 ), headlight, - 0.62, 0.86, 2.1 );
	addPart( new BoxGeometry( 0.38, 0.16, 0.1 ), taillight, 0.62, 0.9, - 2.1 );
	addPart( new BoxGeometry( 0.38, 0.16, 0.1 ), taillight, - 0.62, 0.9, - 2.1 );
	addPart( new BoxGeometry( 1.2, 0.18, 0.08 ), trim, 0, 0.62, 2.12 );

	// Wheels: the two front ones sit inside a pivot so they can be steered.
	const wheelPositions = [
		{ x: - 0.98, z: 1.4, steering: true },
		{ x: 0.98, z: 1.4, steering: true },
		{ x: - 0.98, z: - 1.4, steering: false },
		{ x: 0.98, z: - 1.4, steering: false },
	];

	const wheels = [];
	const steerPivots = [];
	// Nodes moved vertically to emulate suspension, in the same order as `wheelOffsets`.
	const suspension = [];

	for ( const position of wheelPositions ) {

		const wheel = createWheel( rubber, hub );
		wheels.push( wheel );

		if ( position.steering ) {

			const pivot = new Group();
			pivot.name = 'steer-pivot';
			pivot.position.set( position.x, CAR.wheelRadius, position.z );
			pivot.add( wheel );
			chassis.add( pivot );
			steerPivots.push( pivot );
			suspension.push( { node: pivot, baseY: CAR.wheelRadius } );

		} else {

			wheel.position.set( position.x, CAR.wheelRadius, position.z );
			chassis.add( wheel );
			suspension.push( { node: wheel, baseY: CAR.wheelRadius } );

		}

	}

	// Wheel geometries/materials are shared per wheel, so collect one of each.
	for ( const wheel of wheels ) {

		for ( const child of wheel.children ) {

			geometries.push( child.geometry );

		}

	}

	return {
		group,
		chassis,
		wheels,
		steerPivots,
		// Local (x, z) of every wheel. The app uses these to sample the terrain under each
		// wheel and fit the car to the ground instead of hovering over bumps. Local +X is the
		// car's *left* side (see carPhysics.js), so a positive x is a left-hand wheel.
		wheelOffsets: wheelPositions.map( ( position ) => ( { x: position.x, z: position.z } ) ),
		/** Per wheel node plus the height it sits at when fully extended. */
		suspension,
		/**
		 * Repaints the body.
		 *
		 * A room hands each player their colour *after* the car exists (the colour is the
		 * server's to choose), so the paint has to be settable rather than construction-only.
		 *
		 * @param {number} color Hex colour.
		 * @returns {void}
		 */
		setPaint( color ) {

			paint.color.setHex( color );

		},
		dispose() {

			for ( const geometry of geometries ) geometry.dispose();
			for ( const material of materials ) material.dispose();

		},
	};

}
