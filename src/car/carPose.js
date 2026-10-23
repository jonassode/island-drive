/**
 * Fits the car's body to the ground it is standing on.
 *
 * The physics state carries only a position and a heading; this module answers the other half
 * of "where is the car": which way is up, and how far each wheel has to reach to stay in
 * contact.
 *
 * The fit is a least-squares plane through the four wheel contacts, expressed in the car's
 * **own** frame. That framing is the whole point. The car's local +X is its left side (see
 * carPhysics.js), so a gradient of +1 along local x means "the ground rises towards the left
 * of the car" and the body has to bank the other way. Reading the gradient off named wheel
 * pairs instead is easy to get backwards, and it was: the car used to roll *into* every side
 * slope, with its wheels pushed the wrong way to match.
 *
 * Two caps keep a pathological fit (a cliff edge, a rock, a bump narrower than the car) from
 * rolling the car over. Both rotate the up vector inside the plane the lean is already in, so
 * a cap can only ever make the car lean *less*; it can never tip the car to the wrong side of
 * the hill. That is exactly what the old "shorten the horizontal component" clamp got wrong:
 * on ground steeper than the cap it left the body leaning somewhere between the hill and
 * horizontal — which on a real 52 deg slope read as a car propped up at a nonsense angle.
 *
 * Pure and `THREE`-free, so it runs headless under Vitest (`tests/carPose.test.js`) and can
 * drive a second car without touching the renderer. Nothing is allocated per call.
 */

import { CAR } from '../config.js';

/** Vertical: the up vector of a car standing on flat ground. */
const UP = { x: 0, y: 1, z: 0 };
/** Scratch for the terrain's own normal, reused every call. */
const surfaceNormal = { x: 0, y: 1, z: 0 };
/** Wheel contact heights of the current call, grown on demand (never per frame). */
let contactHeights = new Float32Array( 4 );

/**
 * Clamps a value into a range.
 *
 * @param {number} value Value.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @returns {number} The clamped value.
 */
function clamp( value, min, max ) {

	return Math.min( max, Math.max( min, value ) );

}

/**
 * Rotates a unit vector towards another until they are at most `maxAngle` apart.
 *
 * The rotation happens in the plane the two vectors span, so the lean direction is preserved
 * exactly: the result stays on the same side as the input, only less extreme.
 *
 * @param {{x: number, y: number, z: number}} up Unit vector, mutated in place.
 * @param {{x: number, y: number, z: number}} target Unit vector to lean towards.
 * @param {number} maxAngle Largest allowed angle between the two, in radians.
 * @returns {boolean} True when the vector was rotated.
 */
function limitAngle( up, target, maxAngle ) {

	const cos = clamp( up.x * target.x + up.y * target.y + up.z * target.z, - 1, 1 );

	if ( cos >= Math.cos( maxAngle ) ) return false;

	// Axis of the rotation: perpendicular to both, so the rotation stays in their plane.
	const ax = up.y * target.z - up.z * target.y;
	const ay = up.z * target.x - up.x * target.z;
	const az = up.x * target.y - up.y * target.x;
	const axisLength = Math.hypot( ax, ay, az );

	if ( axisLength < 1e-6 ) return false;

	const ux = ax / axisLength;
	const uy = ay / axisLength;
	const uz = az / axisLength;

	// Rodrigues, with the axis perpendicular to `up`, so the result is still a unit vector.
	// The axis is `up x target`, so the rotation that closes the gap is the *positive* one
	// about it, and the direction of travel is `axis x up`. Taking it the other way round
	// (`up x axis`) turns a cap into the opposite of a cap: it would push the body away from
	// the ground by exactly the excess angle it was meant to remove, which is worse than
	// leaving the fit alone.
	const step = Math.acos( cos ) - maxAngle;
	const c = Math.cos( step );
	const s = Math.sin( step );

	const rx = uy * up.z - uz * up.y;
	const ry = uz * up.x - ux * up.z;
	const rz = ux * up.y - uy * up.x;

	up.x = up.x * c + rx * s;
	up.y = up.y * c + ry * s;
	up.z = up.z * c + rz * s;

	return true;

}

/**
 * Fits the car to the terrain under its wheels.
 *
 * Reads nothing from the state but `x`, `z` and `heading`, and needs no meshes: the caller
 * applies the result to the group transform and to the wheel nodes.
 *
 * @param {object} heightField Terrain to sample. `heightAt(x, z)` is required; when
 *   `normalAt(x, z, out)` is available the fit is also guarded against cliffs and rocks.
 * @param {object} state Car state (position and heading).
 * @param {Array<{x: number, z: number}>} wheelOffsets Wheel contacts in the car's local frame.
 * @param {object} [out] Result to reuse, so a per-frame caller allocates nothing. `out.up`
 *   may be a `THREE.Vector3`.
 * @param {object} [config] Vehicle tunables.
 * @returns {{up: {x: number, y: number, z: number}, travel: Float32Array, groundY: number}} The
 *   same `out`: the body's unit up vector, how far each wheel must move vertically to touch
 *   the ground (already capped to `config.suspensionTravel`), and the height the fitted body
 *   plane passes through at the car's origin.
 */
export function fitCarToGround( heightField, state, wheelOffsets, out = {}, config = CAR ) {

	const heading = state.heading;
	const forwardX = Math.sin( heading );
	const forwardZ = Math.cos( heading );
	// The car's local +X is its left side, so this is the direction it points.
	const leftX = Math.cos( heading );
	const leftZ = - Math.sin( heading );

	const count = wheelOffsets.length;

	if ( contactHeights.length < count ) contactHeights = new Float32Array( count );

	// Sized to the car being fitted, so one `out` reused for two cars of different wheel counts
	// stays correct instead of silently dropping wheels. A match, the per-frame case,
	// allocates nothing.
	if ( out.travel === undefined || out.travel.length !== count ) {

		out.travel = new Float32Array( count );

	}

	const travel = out.travel;

	// The least-squares plane `h = x * gradeX + z * gradeZ + centre` through the contacts. The
	// wheel offsets are symmetric about the car's origin, so the cross terms cancel and each
	// grade is just the covariance over the variance.
	let sumX = 0;
	let sumZ = 0;
	let sumXX = 0;
	let sumZZ = 0;
	let centre = 0;

	for ( let i = 0; i < count; i ++ ) {

		const offset = wheelOffsets[ i ];
		const worldX = state.x + offset.x * leftX + offset.z * forwardX;
		const worldZ = state.z + offset.x * leftZ + offset.z * forwardZ;
		const height = heightField.heightAt( worldX, worldZ );

		contactHeights[ i ] = height;
		sumX += offset.x * height;
		sumZ += offset.z * height;
		sumXX += offset.x * offset.x;
		sumZZ += offset.z * offset.z;
		centre += height;

	}

	centre /= count;

	/** Ground rise per unit towards the car's left (its local +X). */
	const gradeX = sumXX > 1e-9 ? sumX / sumXX : 0;
	/** Ground rise per unit towards the car's nose (its local +Z). */
	const gradeZ = sumZZ > 1e-9 ? sumZ / sumZZ : 0;

	// The same plane written in world axes, as the ground's own gradient.
	const gx = gradeZ * forwardX + gradeX * leftX;
	const gz = gradeZ * forwardZ + gradeX * leftZ;

	const up = out.up ?? ( out.up = { x: 0, y: 1, z: 0 } );
	const length = Math.hypot( gx, 1, gz );

	up.x = - gx / length;
	up.y = 1 / length;
	up.z = - gz / length;

	// A cliff edge, a rock or a bump narrower than the car fits a plane far steeper than the
	// ground it stands on, and leaning that far is what rolls the car over. Capping the lean
	// *relative to the terrain's own normal* only engages when the contacts really do
	// disagree with the landscape, so ordinary hills -- however steep -- are followed exactly.
	if ( typeof heightField.normalAt === 'function' ) {

		limitAngle( up, heightField.normalAt( state.x, state.z, surfaceNormal ), config.maxTiltDeviation );

	}

	// Absolute rollover guard, set above the steepest drivable ground: a safety net rather
	// than a limit on the hills (see CAR.maxTilt).
	limitAngle( up, UP, config.maxTilt );

	// Visual suspension: the body keeps the fitted plane and each wheel reaches for the
	// ground under it, so bumps do not leave wheels hanging in the air.
	for ( let i = 0; i < count; i ++ ) {

		const offset = wheelOffsets[ i ];
		const plane = centre + offset.x * gradeX + offset.z * gradeZ;

		travel[ i ] = clamp(
			contactHeights[ i ] - plane,
			- config.suspensionTravel,
			config.suspensionTravel,
		);

	}

	out.groundY = centre;

	return out;

}