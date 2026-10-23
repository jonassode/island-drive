import { describe, expect, it } from 'vitest';
import { PATH, WORLD } from '../src/config.js';
import { createHeightField } from '../src/world/heightfield.js';
import { createPathField } from '../src/world/pathField.js';

const SEED = 12345;
/** A spread of islands, including the seeds the smoke test pins for its checks. */
const SEEDS = [ 0, 1, 2, 3, 7, 42, 99, 555, 31677, SEED ];

/**
 * Builds the path field of a fresh island.
 *
 * @param {number} seed Island seed.
 * @returns {object} The path field.
 */
function build( seed ) {

	return createPathField( createHeightField( { seed } ) );

}

describe( 'createPathField', () => {

	it( 'is deterministic for a given seed', () => {

		const a = build( SEED );
		const b = build( SEED );

		expect( b.points ).toEqual( a.points );
		expect( b.length ).toBeCloseTo( a.length, 9 );

		for ( let i = 0; i < 20; i ++ ) {

			const angle = ( i / 20 ) * Math.PI * 2;
			expect( b.radiusAt( angle ) ).toBe( a.radiusAt( angle ) );

		}

	} );

	it( 'wraps a different loop around a different island', () => {

		const a = build( 1 );
		const b = build( 2 );

		// Not just rotated: the outline itself must follow the seed.
		let largest = 0;

		for ( let i = 0; i < 64; i ++ ) {

			const angle = ( i / 64 ) * Math.PI * 2;
			largest = Math.max( largest, Math.abs( a.radiusAt( angle ) - b.radiusAt( angle ) ) );

		}

		expect( largest ).toBeGreaterThan( 5 );

	} );

	it( 'keeps the loop a single closed curve', () => {

		for ( const seed of SEEDS ) {

			const field = build( seed );
			const points = field.points;
			const turn = Math.PI * 2 / points.length;

			// One lap: the bearing advances by exactly one step per station and never
			// backtracks, which is what makes the loop single and non-self-crossing.
			points.forEach( ( point, index ) => {

				expect( point.angle ).toBeCloseTo( index * turn, 9 );

			} );

			// The heading never reverses, so the curve has no kink and folds back on itself
			// nowhere. (A star-shaped loop can still do that if the wobble is too strong.)
			let previousSign = 0;

			for ( let i = 0; i < points.length; i ++ ) {

				const previous = points[ ( i - 1 + points.length ) % points.length ];
				const current = points[ i ];
				const next = points[ ( i + 1 ) % points.length ];

				const inX = current.x - previous.x;
				const inZ = current.z - previous.z;
				const outX = next.x - current.x;
				const outZ = next.z - current.z;

				const sign = Math.sign( inX * outZ - inZ * outX );

				if ( sign !== 0 ) {

					if ( previousSign !== 0 ) expect( sign ).toBe( previousSign );
					previousSign = sign;

				}

			}

		}

	} );

	it( 'closes on itself with a full length step, not a shorter seam', () => {

		for ( const seed of SEEDS ) {

			const points = build( seed ).points;
			let total = 0;
			let closing = 0;

			for ( let i = 0; i < points.length; i ++ ) {

				const point = points[ i ];
				const next = points[ ( i + 1 ) % points.length ];
				const step = Math.hypot( next.x - point.x, next.z - point.z );

				if ( i === points.length - 1 ) closing = step;
				else total += step;

			}

			const mean = total / ( points.length - 1 );

			// The last station wraps back to the first like any other pair, so the gap is the
			// ordinary station spacing rather than a long straight jump across the seam.
			expect( closing ).toBeGreaterThan( mean * 0.5 );
			expect( closing ).toBeLessThan( mean * 1.5 );

		}

	} );
it( 'stays on dry land, well clear of the waterline', () => {

		for ( const seed of SEEDS ) {

			const heightField = createHeightField( { seed } );
			const pathField = createPathField( heightField );

			for ( const point of pathField.points ) {

				const cos = Math.cos( point.angle );
				const sin = Math.sin( point.angle );
				const outward = point.radius + point.width;

				// The whole tread is on land, edges included...
				expect( heightField.isLand( point.x, point.z ) ).toBe( true );
				expect( heightField.isLand( point.x + cos * point.width, point.z + sin * point.width ) ).toBe( true );
				expect( heightField.isLand( point.x - cos * point.width, point.z - sin * point.width ) ).toBe( true );

				// ...and there is a real margin of land beyond it before the beach starts.
				expect( heightField.isLand( cos * ( outward + 40 ), sin * ( outward + 40 ) ) ).toBe( true );

			}

		}

	} );

	it( 'runs around the island flank, neither at the shore nor at the centre', () => {

		for ( const seed of SEEDS ) {

			const heightField = createHeightField( { seed } );
			const field = createPathField( heightField );
			const fractions = field.points.map( ( point ) => point.radius / heightField.radius );
			const mean = fractions.reduce( ( sum, value ) => sum + value, 0 ) / fractions.length;

			// Measured against the terrain: land reaches at least ~0.71 of the radius, so a
			// loop inside 0.68 is always on the island, and one outside 0.5 is far enough out
			// to read as a lap of the island rather than a circle in the middle of it.
			expect( Math.min( ...fractions ) ).toBeGreaterThan( 0.5 );
			expect( Math.max( ...fractions ) ).toBeLessThan( 0.68 );
			expect( mean ).toBeCloseTo( PATH.radius, 2 );

			// A lap of the island, not a short hop: the perimeter is roughly the ring's.
			expect( field.length ).toBeGreaterThan( Math.PI * 2 * heightField.radius * 0.5 );
			expect( field.length ).toBeLessThan( Math.PI * 2 * heightField.radius * 0.75 );

		}

	} );

	it( 'goes over the island\'s hills instead of rounding them', () => {

		for ( const seed of SEEDS ) {

			const heightField = createHeightField( { seed } );
			const pathField = createPathField( heightField );
			const heights = pathField.points.map( ( point ) => heightField.heightAt( point.x, point.z ) );

			// Over the whole ring the path has to climb and descend real terrain: measured
			// across these seeds the range is 38-95 u, so this is a generous floor that still
			// fails outright if the loop were ever moved onto the flat coastal shelf.
			expect( Math.max( ...heights ) - Math.min( ...heights ) ).toBeGreaterThan( 15 );

		}

	} );

	it( 'varies its width without pinching shut', () => {

		for ( const seed of SEEDS ) {

			const widths = build( seed ).points.map( ( point ) => point.width );
			const min = Math.min( ...widths );
			const max = Math.max( ...widths );

			expect( min ).toBeGreaterThan( PATH.halfWidth * 0.5 );
			expect( max ).toBeLessThan( PATH.halfWidth * 1.5 );
			expect( max ).toBeGreaterThan( min );

		}

	} );

	it( 'reports what lies on the path', () => {

		const heightField = createHeightField( { seed: SEED } );
		const pathField = createPathField( heightField );

		for ( let i = 0; i < 32; i ++ ) {

			const angle = ( i / 32 ) * Math.PI * 2;
			const radius = pathField.radiusAt( angle );
			const halfWidth = pathField.halfWidthAt( angle );
			const cos = Math.cos( angle );
			const sin = Math.sin( angle );

			const centre = { x: cos * radius, z: sin * radius };
			const inside = { x: cos * ( radius - halfWidth * 0.9 ), z: sin * ( radius - halfWidth * 0.9 ) };
			const outside = { x: cos * ( radius - halfWidth * 1.6 ), z: sin * ( radius - halfWidth * 1.6 ) };

			expect( pathField.distanceFromPath( centre.x, centre.z ) ).toBeCloseTo( 0, 6 );
			expect( pathField.isOnPath( centre.x, centre.z ) ).toBe( true );
			expect( pathField.isOnPath( inside.x, inside.z ) ).toBe( true );
			expect( pathField.isOnPath( outside.x, outside.z ) ).toBe( false );

			expect( pathField.distanceFromPath( inside.x, inside.z ) ).toBeCloseTo( halfWidth * 0.9, 6 );

		}

		// Nothing in the middle of the island, or out at sea, is on the path.
		expect( pathField.isOnPath( 0, 0 ) ).toBe( false );
		expect( pathField.isOnPath( WORLD.islandRadius * 1.2, 0 ) ).toBe( false );

	} );

} );