import { describe, expect, it } from 'vitest';
import { CAR } from '../src/config.js';
import { mulberry32 } from '../src/world/rng.js';
import { fitCarToGround } from '../src/car/carPose.js';

/**
 * The real wheel contacts, in the order `buildCar()` creates them: front-right, front-left,
 * rear-right, rear-left.
 *
 * Local +X is the car's **left** (see carPhysics.js), so a positive x is a left-hand wheel and
 * a negative one is a right-hand wheel. Which side a wheel is on is exactly the thing the old
 * pose formula got backwards, so these signs matter.
 */
const WHEELS = [
	{ x: - 0.98, z: 1.4 },
	{ x: 0.98, z: 1.4 },
	{ x: - 0.98, z: - 1.4 },
	{ x: 0.98, z: - 1.4 },
];

/** Vertical: what a car standing on flat ground points along. */
const UP = { x: 0, y: 1, z: 0 };

/** Both tilt caps disabled, to inspect the raw fit that the guards then correct. */
const UNCAPPED = { ...CAR, maxTiltDeviation: Math.PI / 2, maxTilt: Math.PI / 2 };

/**
 * Dot product of two vectors.
 *
 * @param {{x: number, y: number, z: number}} a First vector.
 * @param {{x: number, y: number, z: number}} b Second vector.
 * @returns {number} The dot product.
 */
function dot( a, b ) {

	return a.x * b.x + a.y * b.y + a.z * b.z;

}

/**
 * Angle between two vectors, in radians.
 *
 * @param {{x: number, y: number, z: number}} a First vector.
 * @param {{x: number, y: number, z: number}} b Second vector.
 * @returns {number} Angle in radians.
 */
function angleBetween( a, b ) {

	const cos = dot( a, b ) / ( Math.hypot( a.x, a.y, a.z ) * Math.hypot( b.x, b.y, b.z ) );

	return Math.acos( Math.max( - 1, Math.min( 1, cos ) ) );

}

/**
 * Radians to degrees, so the assertions can be phrased in the units the config uses.
 *
 * @param {number} radians Angle in radians.
 * @returns {number} Angle in degrees.
 */
function degrees( radians ) {

	return radians * 180 / Math.PI;

}

/**
 * A car state standing at a spot, facing a heading.
 *
 * `fitCarToGround` reads nothing else, so this is the whole state the fit needs.
 *
 * @param {object} field Height field.
 * @param {number} heading Facing in radians: forward is (sin, 0, cos).
 * @param {number} [x] World x.
 * @param {number} [z] World z.
 * @returns {object} State stand in.
 */
function stateAt( field, heading, x = 0, z = 0 ) {

	return { x, z, y: field.heightAt( x, z ), heading };

}

/**
 * A flat, endless field with a normal that agrees with it.
 *
 * @returns {object} Height field stand in.
 */
function createFlatField() {

	return {
		heightAt() {

			return 0;

		},
		normalAt( x, z, out = { x: 0, y: 1, z: 0 } ) {

			out.x = 0;
			out.y = 1;
			out.z = 0;

			return out;

		},
	};

}

/**
 * A uniform slope: `height = gradeX * x + gradeZ * z`.
 *
 * A plane is the one terrain a least-squares fit can reproduce *exactly*, which is what makes
 * it the right instrument here: every assertion against it is a statement about the
 * orientation of the fit and nothing else. However the car is facing and wherever it stands,
 * its up vector has to come out equal to this plane's normal -- and if the local-to-world
 * conversion mixes up the axes, it comes out mirrored instead, which is the bug this file
 * exists to prevent.
 *
 * @param {number} gradeX Rise per unit towards world +x.
 * @param {number} gradeZ Rise per unit towards world +z.
 * @returns {object} Height field stand in.
 */
function createRampField( gradeX, gradeZ ) {

	const length = Math.hypot( gradeX, 1, gradeZ );

	return {
		heightAt( x, z ) {

			return gradeX * x + gradeZ * z;

		},
		normalAt( x, z, out = { x: 0, y: 1, z: 0 } ) {

			out.x = - gradeX / length;
			out.y = 1 / length;
			out.z = - gradeZ / length;

			return out;

		},
	};

}

/**
 * A flat field with a hump under the front-right wheel and nowhere else.
 *
 * The hump is far narrower than the car, which is the pathological shape the deviation cap
 * exists for: a rock, a kerb, or the lip of a ditch. The ground *under the car* is flat, so
 * the terrain normal at the car's origin stays vertical while the fitted plane tips.
 *
 * @param {number} height Hump height. Negative digs a hole.
 * @param {number} [radius] Hump radius, in world units.
 * @returns {object} Height field stand in.
 */
function createHumpField( height, radius = 0.3 ) {

	const field = createFlatField();
	const contact = WHEELS[ 0 ];

	field.heightAt = ( x, z ) => (
		Math.hypot( x - contact.x, z - contact.z ) < radius ? height : 0
	);

	return field;

}

/**
 * Rough ground whose gradient is known exactly, for the invariant sweep.
 *
 * The gradient is analytic rather than finite-differenced, so the sweep measures the caps
 * against the very value the module was handed: no sampling error can hide behind a tolerance.
 *
 * The wavelengths are chosen deliberately, one per scale that matters. The long ones are
 * ordinary hills, which the body has to follow exactly -- the deviation cap must never fight
 * them. The five-unit one, against a 2.8 x 2 unit wheel footprint, is the awkward scale:
 * neighbouring wheels land on opposite phases of it, so the fitted plane genuinely disagrees
 * with the ground under the car. The last one is a rock field, spikier than anything this
 * island generates. It is even in z and odd in x, so the left and right wheels *sum* rather
 * than cancel: a term they cannot average away, which is what it takes to roll the fitted
 * plane far enough to meet the absolute rollover guard. Both caps are therefore exercised by
 * the sweep, not merely present -- the counters at its end assert exactly that.
 *
 * @returns {object} Height field stand in.
 */
function createRoughField() {

	function heightAt( x, z ) {

		return 12 * Math.sin( 0.04 * x ) * Math.cos( 0.03 * z ) +
			4 * Math.sin( 0.09 * ( x + z ) ) +
			4 * Math.sin( 2.2 * x ) * Math.cos( 2 * z );

	}

	function gradientX( x, z ) {

		return 12 * 0.04 * Math.cos( 0.04 * x ) * Math.cos( 0.03 * z ) +
			4 * 0.09 * Math.cos( 0.09 * ( x + z ) ) +
			4 * 2.2 * Math.cos( 2.2 * x ) * Math.cos( 2 * z );

	}

	function gradientZ( x, z ) {

		return - 12 * 0.03 * Math.sin( 0.04 * x ) * Math.sin( 0.03 * z ) +
			4 * 0.09 * Math.cos( 0.09 * ( x + z ) ) -
			4 * 2 * Math.sin( 2.2 * x ) * Math.sin( 2 * z );

	}

	return {
		heightAt,
		normalAt( x, z, out = { x: 0, y: 1, z: 0 } ) {

			const gx = gradientX( x, z );
			const gz = gradientZ( x, z );
			const length = Math.hypot( gx, 1, gz );

			out.x = - gx / length;
			out.y = 1 / length;
			out.z = - gz / length;

			return out;

		},
	};

}

describe( 'car ground fit', () => {

	it( 'stands level and level-headed on flat ground', () => {

		const field = createFlatField();
		const pose = fitCarToGround( field, stateAt( field, 0 ), WHEELS );

		// Exactly vertical. The horizontal parts come back as signed zeros, so the claim is
		// that there is no horizontal tilt at all rather than that x is exactly +0.
		expect( Math.hypot( pose.up.x, pose.up.z ) ).toBe( 0 );
		expect( pose.up.y ).toBe( 1 );
		expect( pose.groundY ).toBe( 0 );

		for ( const travel of pose.travel ) expect( travel ).toBeCloseTo( 0, 6 );

	} );

	it( 'banks away from a side slope instead of into it', () => {

		// Ground that climbs towards world +x, with the car facing +z. World +x is the car's
		// *left*, so the hill is on the left and the body has to bank to the right, down the
		// hill: up must tilt towards -x, away from the ground, never into it.
		const slope = 29 * Math.PI / 180;
		const field = createRampField( Math.tan( slope ), 0 );
		const normal = field.normalAt( 0, 0 );
		const pose = fitCarToGround( field, stateAt( field, 0 ), WHEELS );

		expect( pose.up.x ).toBeLessThan( 0 );
		expect( pose.up.z ).toBeCloseTo( 0, 6 );
		expect( degrees( angleBetween( pose.up, UP ) ) ).toBeCloseTo( 29, 3 );

		// The regression, measured on exactly this hill: reading the roll off named wheel pairs
		// put the body 58 degrees off the terrain normal -- mirrored, leaning *into* the slope.
		// Matching the ground's own normal is the whole assertion, sign included.
		expect( degrees( angleBetween( pose.up, normal ) ) ).toBeCloseTo( 0, 3 );

	} );

	it( 'lifts the nose when the hill climbs ahead', () => {

		// Climbing towards world +z, which is straight ahead at heading 0: up has to lean back
		// so the nose comes up with the ground.
		const field = createRampField( 0, Math.tan( 20 * Math.PI / 180 ) );
		const pose = fitCarToGround( field, stateAt( field, 0 ), WHEELS );

		expect( pose.up.z ).toBeLessThan( 0 );
		expect( pose.up.x ).toBeCloseTo( 0, 6 );
		expect( degrees( angleBetween( pose.up, field.normalAt( 0, 0 ) ) ) ).toBeCloseTo( 0, 3 );

	} );

	it( 'follows a slope exactly, whichever way the car is facing', () => {

		// A plane has no heading, so the fit has to land on the same world normal at every
		// heading. Any sign or axis slip in the local-to-world conversion shows up here as a
		// body leaning the wrong way -- twice the slope's angle away from the ground.
		const field = createRampField( 0.45, - 0.3 );
		const normal = field.normalAt( 0, 0 );

		for ( let i = 0; i < 16; i ++ ) {

			const heading = i / 16 * Math.PI * 2;
			const pose = fitCarToGround( field, stateAt( field, heading ), WHEELS );

			expect( degrees( angleBetween( pose.up, normal ) ) ).toBeCloseTo( 0, 3 );

			// Same side as the ground's normal, in the horizontal plane: downhill.
			expect( pose.up.x * normal.x + pose.up.z * normal.z ).toBeGreaterThan( 0 );

		}

	} );

	it( 'caps a fit that disagrees with the ground, without flipping it over', () => {

		// A 5 unit hump under the front-right wheel, flat everywhere else. The wheels disagree
		// with the ground the car is standing on, so a body that simply followed them would
		// lean ~57 degrees on flat terrain. A rigid body tipping that far over a kerb is how it
		// ends up on its roof, and the terrain normal at the car's origin stays vertical: this
		// is precisely the disagreement the deviation cap is measured against.
		const field = createHumpField( 5 );
		const state = stateAt( field, 0 );
		const normal = field.normalAt( 0, 0 );

		const raw = fitCarToGround( field, state, WHEELS, {}, UNCAPPED );
		const pose = fitCarToGround( field, state, WHEELS );

		// The cap only engages because the fit really does disagree with the landscape.
		expect( angleBetween( raw.up, normal ) ).toBeGreaterThan( CAR.maxTiltDeviation );

		expect( angleBetween( pose.up, normal ) ).toBeCloseTo( CAR.maxTiltDeviation, 6 );
		expect( angleBetween( pose.up, UP ) ).toBeLessThan( CAR.maxTilt );

		// A cap may only ever reduce the lean: the same corner of the car it was tipping
		// towards, less of the tip. The old clamp, which shortened the horizontal component of
		// the normal, could instead leave the body propped up between the hill and the horizon.
		expect( dot( pose.up, raw.up ) ).toBeGreaterThan( 0 );
		expect( pose.up.y ).toBeGreaterThan( raw.up.y );

		// The hump is under the car's *right* wheel, so the body tips to its left and up leans
		// towards +x. Getting this backwards is the mirrored-body bug, so it is asserted here
		// even though the cap, not the wheels, decided the final angle.
		expect( pose.up.x ).toBeGreaterThan( 0 );
		expect( Math.hypot( pose.up.x, pose.up.y, pose.up.z ) ).toBeCloseTo( 1, 6 );

	} );

	it( 'never leans past CAR.maxTilt, however steep the ground is', () => {

		// A 76 degree face: steeper than anything the car can drive, but *consistent*, so the
		// fit agrees with the terrain's own normal and the deviation cap cannot fire. Held
		// upright here is the absolute rollover guard alone, which is the point of having it.
		const field = createRampField( 4, 0 );
		const pose = fitCarToGround( field, stateAt( field, 0 ), WHEELS );

		expect( angleBetween( pose.up, UP ) ).toBeCloseTo( CAR.maxTilt, 6 );
		// Capped, but still on the downhill side of the cliff rather than tipped over it.
		expect( pose.up.x ).toBeLessThan( 0 );
		expect( pose.up.y ).toBeGreaterThan( 0 );

	} );

	it( 'has every wheel touching when the ground is a plane', () => {

		// A plane fits exactly, so a rigid body is already touching all four contacts and no
		// wheel has any reaching left to do.
		const ramp = createRampField( 0.4, - 0.2 );
		const pose = fitCarToGround( ramp, stateAt( ramp, 0.7, 30, - 12 ), WHEELS );

		for ( const travel of pose.travel ) expect( travel ).toBeCloseTo( 0, 4 );

	} );

	it( 'reaches for a bump, and stops at the end of the suspension travel', () => {

		const BUMP = 0.2;
		const bump = createHumpField( BUMP );
		const pose = fitCarToGround( bump, stateAt( bump, 0 ), WHEELS );

		// The raised corner is the front-right wheel, so that wheel alone travels up, while the
		// body tips away from it and the diagonally opposite wheel hangs down to compensate.
		expect( pose.travel[ 0 ] ).toBeGreaterThan( 0 );
		expect( pose.travel[ 0 ] ).toBeLessThan( BUMP );
		expect( pose.travel[ 1 ] ).toBeLessThan( 0 );

		// Past the end of the travel the wheel gives up rather than dragging the body with it: a
		// hole leaves it at full droop, a spike at full compression, and the body on its plane.
		const hole = createHumpField( - 5 );
		expect( fitCarToGround( hole, stateAt( hole, 0 ), WHEELS ).travel[ 0 ] )
			.toBeCloseTo( - CAR.suspensionTravel, 6 );

		const spike = createHumpField( 5 );
		expect( fitCarToGround( spike, stateAt( spike, 0 ), WHEELS ).travel[ 0 ] )
			.toBeCloseTo( CAR.suspensionTravel, 6 );

	} );

	it( 'reuses the result it is handed, so a per-frame caller allocates nothing', () => {

		const field = createRampField( 0.45, - 0.3 );
		const pose = {};

		expect( fitCarToGround( field, stateAt( field, 0 ), WHEELS, pose ) ).toBe( pose );

		const up = pose.up;
		const travel = pose.travel;
		const atOrigin = pose.groundY;

		// The same call from a different spot: the fit has to write into the very same objects
		// rather than hand back fresh ones, or the render loop allocates on every frame.
		fitCarToGround( field, stateAt( field, 1.1, 120, - 40 ), WHEELS, pose );

		expect( pose.up ).toBe( up );
		expect( pose.travel ).toBe( travel );
		expect( pose.travel ).toHaveLength( WHEELS.length );

		// A plane is the same plane wherever it is measured, so only the height moved.
		expect( pose.up.y ).toBeCloseTo( up.y, 9 );
		expect( pose.groundY ).toBeCloseTo( field.heightAt( 120, - 40 ), 6 );
		expect( pose.groundY ).not.toBeCloseTo( atOrigin, 6 );

	} );

	it( 'sizes and guards its output for a car with fewer wheels', () => {

		const field = createFlatField();
		const pose = {};
		/** Two wheels on one line: a motorcycle, which cannot see a cross slope at all. */
		const bike = [ { x: 0, z: 1.4 }, { x: 0, z: - 1.4 } ];

		fitCarToGround( field, stateAt( field, 0 ), WHEELS, pose );
		const travel = pose.travel;

		// The same `out` handed to a different car has to resize rather than drop wheels.
		fitCarToGround( field, stateAt( field, 0 ), bike, pose );

		expect( pose.travel ).not.toBe( travel );
		expect( pose.travel ).toHaveLength( bike.length );

		// Wheels with no spread across the car give the roll nothing to divide by: the guard
		// has to return a level roll and a unit up vector, not a NaN.
		const cross = createRampField( 0.6, 0 );
		const bareCross = { heightAt: cross.heightAt };
		fitCarToGround( bareCross, stateAt( bareCross, 0 ), bike, pose );

		expect( pose.up.x ).toBeCloseTo( 0, 12 );
		expect( Math.hypot( pose.up.x, pose.up.y, pose.up.z ) ).toBeCloseTo( 1, 12 );

		// Down the fall line it can still pitch, and does.
		const fall = createRampField( 0, 0.6 );
		const bareFall = { heightAt: fall.heightAt };
		fitCarToGround( bareFall, stateAt( bareFall, 0 ), bike, pose );

		expect( pose.up.z ).toBeCloseTo( - 0.6 / Math.hypot( 0.6, 1 ), 12 );

	} );

	it( 'fits ground that cannot report a normal', () => {

		// Guarding against cliffs is optional. A caller that only samples heights -- a
		// simplified ground, a second car on a placeholder terrain -- must still get a fit,
		// and on a consistent slope it must be the same one.
		const ramp = createRampField( 0.5, 0 );
		const bare = { heightAt: ramp.heightAt };
		const pose = fitCarToGround( bare, stateAt( bare, 0.9 ), WHEELS );

		expect( degrees( angleBetween( pose.up, ramp.normalAt( 0, 0 ) ) ) ).toBeCloseTo( 0, 3 );

	} );

	it( 'holds its invariants over rough ground', () => {

		// A seeded sweep over a rough field, because the interesting failures are not on the
		// tidy terrain above: they are on the crests, in the dips and across the five-unit
		// lumps where the four wheels disagree with each other. The counters prove the sweep
		// actually reaches both guards instead of quietly testing nothing.
		const field = createRoughField();
		const random = mulberry32( 7 );
		const pose = {};
		const rawPose = {};

		let cappedByDeviation = 0;
		let cappedByMaxTilt = 0;

		for ( let i = 0; i < 400; i ++ ) {

			const state = {
				x: ( random.random() - 0.5 ) * 400,
				z: ( random.random() - 0.5 ) * 400,
				heading: random.random() * Math.PI * 2,
			};

			fitCarToGround( field, state, WHEELS, pose );
			fitCarToGround( field, state, WHEELS, rawPose, UNCAPPED );

			const normal = field.normalAt( state.x, state.z );
			const lean = angleBetween( pose.up, UP );
			const rawLean = angleBetween( rawPose.up, UP );
			const rawDeviation = angleBetween( rawPose.up, normal );

			if ( rawDeviation > CAR.maxTiltDeviation ) cappedByDeviation ++;
			if ( rawLean > CAR.maxTilt ) cappedByMaxTilt ++;

			// A unit up vector on the upper hemisphere: the body never turns over, and the
			// quaternion the caller builds from it can never flip the car.
			expect( Math.hypot( pose.up.x, pose.up.y, pose.up.z ) ).toBeCloseTo( 1, 6 );
			expect( pose.up.y ).toBeGreaterThan( 0 );
			expect( lean ).toBeLessThanOrEqual( CAR.maxTilt + 1e-9 );

			// Where the rollover guard had nothing to do, the body is on the ground under it:
			// an honest hillside is followed exactly, and a fit that disagrees with the
			// landscape is pulled towards it rather than away from it.
			if ( lean < CAR.maxTilt - 1e-6 ) {

				expect( angleBetween( pose.up, normal ) ).toBeLessThanOrEqual( CAR.maxTiltDeviation + 1e-9 );
				expect( dot( pose.up, normal ) ).toBeGreaterThanOrEqual( dot( rawPose.up, normal ) - 1e-9 );

			}

			// `travel` is a Float32Array, so a value clamped to the cap comes back a few 1e-8 above
			// it. The slack is for that storage rounding, not for an approximate cap.
			for ( const travel of pose.travel ) {
				expect( Math.abs( travel ) ).toBeLessThanOrEqual( CAR.suspensionTravel + 1e-6 );
			}

		}

		expect( cappedByDeviation ).toBeGreaterThan( 0 );
		expect( cappedByMaxTilt ).toBeGreaterThan( 0 );

	} );

} );