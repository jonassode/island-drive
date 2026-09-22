import { describe, expect, it } from 'vitest';
import { ISLAND, WORLD } from '../src/config.js';
import { createHeightField } from '../src/world/heightfield.js';

const SEED = 12345;

/**
 * Samples the field on a grid, scaled to the world size so tests stay fast.
 *
 * @param {object} field Height field.
 * @param {number} [steps] Samples per axis.
 * @returns {Array<{x: number, z: number, height: number}>} Samples.
 */
function sampleGrid( field, steps = 48 ) {

	const samples = [];
	const half = field.size / 2;
	const step = field.size / steps;

	for ( let i = 0; i <= steps; i ++ ) {

		for ( let j = 0; j <= steps; j ++ ) {

			const x = - half + i * step;
			const z = - half + j * step;

			samples.push( { x, z, height: field.heightAt( x, z ) } );

		}

	}

	return samples;

}

describe( 'createHeightField', () => {

	it( 'is deterministic for a given seed', () => {

		const a = createHeightField( { seed: SEED } );
		const b = createHeightField( { seed: SEED } );

		for ( let i = 0; i < 200; i ++ ) {

			const x = ( i * 37 ) % 1800 - 900;
			const z = ( i * 53 ) % 1800 - 900;
			expect( a.heightAt( x, z ) ).toBe( b.heightAt( x, z ) );

		}

	} );

	it( 'produces different terrain for different seeds', () => {

		const a = createHeightField( { seed: 1 } );
		const b = createHeightField( { seed: 2 } );
		const c = createHeightField( { seed: 3 } );

		// Both the hills and the surface detail must follow the seed.
		const differing = sampleGrid( a ).filter( ( sample ) => (
			Math.abs( sample.height - b.heightAt( sample.x, sample.z ) ) > 0.05
		) );

		expect( differing.length ).toBeGreaterThan( 100 );
		expect( a.hills[ 0 ].x ).not.toBeCloseTo( c.hills[ 0 ].x, 3 );

	} );

	it( 'always keeps the island centre above sea level', () => {

		for ( const seed of [ 0, 1, 7, SEED, 987654 ] ) {

			const field = createHeightField( { seed } );
			expect( field.heightAt( 0, 0 ) ).toBeGreaterThan( field.seaLevel );

		}

	} );

	it( 'surrounds the island with water', () => {

		for ( const seed of [ 0, 3, SEED, 555 ] ) {

			const field = createHeightField( { seed } );

			for ( let angle = 0; angle < Math.PI * 2; angle += Math.PI / 6 ) {

				for ( const factor of [ 1.0, 1.2, 1.6 ] ) {

					const x = Math.cos( angle ) * field.radius * factor;
					const z = Math.sin( angle ) * field.radius * factor;

					expect( field.isLand( x, z ) ).toBe( false );
					expect( field.heightAt( x, z ) ).toBeLessThan( field.seaLevel );

				}

			}

		}

	} );

	it( 'returns finite heights with a healthy spread', () => {

		const field = createHeightField( { seed: SEED } );
		const samples = sampleGrid( field ).map( ( sample ) => sample.height );

		expect( samples.every( ( height ) => Number.isFinite( height ) ) ).toBe( true );

		const min = Math.min( ...samples );
		const max = Math.max( ...samples );

		expect( max ).toBeGreaterThan( 30 );
		expect( min ).toBeLessThan( field.seaLevel );

	} );

	it( 'scatters hills across the whole island rather than stacking one in the middle', () => {

		const field = createHeightField( { seed: SEED } );

		// Sparse by design: enough hills to cover the island, few enough that their footprints
		// leave real lowland between them (see `hillCount` in the config).
		expect( field.hills.length ).toBeGreaterThan( 25 );
		expect( field.hills.length ).toBeLessThanOrEqual( WORLD.hillCount );

		// Every quadrant must contain hills, and none of them may sit inside the water.
		const quadrants = new Set();

		for ( const hill of field.hills ) {

			quadrants.add( `${hill.x >= 0 ? 'e' : 'w'}${hill.z >= 0 ? 'n' : 's'}` );

			expect( Math.hypot( hill.x, hill.z ) ).toBeLessThan( field.radius );
			expect( hill.height ).toBeGreaterThan( 0 );
			expect( hill.height ).toBeLessThanOrEqual( WORLD.hillMaxGrade * hill.radius + 1e-9 );

		}

		expect( quadrants.size ).toBe( 4 );

	} );

	it( 'has many separate high points, not a single central summit', () => {

		const field = createHeightField( { seed: SEED } );
		const steps = 40;
		const half = field.size / 2;
		const step = field.size / steps;
		const threshold = ISLAND.grassHeight;

		// Count local maxima above a high threshold on a coarse grid.
		const grid = [];

		for ( let i = 0; i <= steps; i ++ ) {

			grid[ i ] = [];

			for ( let j = 0; j <= steps; j ++ ) {

				grid[ i ][ j ] = field.heightAt( - half + i * step, - half + j * step );

			}

		}

		const peaks = [];
		let highest = - Infinity;

		for ( let i = 1; i < steps; i ++ ) {

			for ( let j = 1; j < steps; j ++ ) {

				const height = grid[ i ][ j ];
				highest = Math.max( highest, height );

				if ( height < threshold ) continue;

				const isPeak = grid[ i - 1 ][ j ] < height && grid[ i + 1 ][ j ] < height &&
					grid[ i ][ j - 1 ] < height && grid[ i ][ j + 1 ] < height;

				if ( isPeak ) peaks.push( { x: - half + i * step, z: - half + j * step, height } );

			}

		}

		// Several tall, well separated hills. The threshold is the top of the grass band, so
		// these are peaks that stand out of the lowland rather than noise on a plateau.
		expect( peaks.length ).toBeGreaterThan( 4 );
		expect( Math.max( ...peaks.map( ( peak ) => peak.height ) ) ).toBeCloseTo( highest, 5 );

		const farApart = peaks.filter( ( peak ) => Math.hypot( peak.x, peak.z ) > field.radius * 0.4 );
		expect( farApart.length ).toBeGreaterThan( 1 );

	} );

	it( 'keeps the island mostly lowland instead of one saturated plateau', () => {

		// Regression guard. The hills sum, so a hill count high enough for their footprints to
		// blanket the island merges them into a single plateau pinned at `hillHeightCap`. That
		// turned the entire interior into rock and snow, leaving grass only as a rim at the
		// shoreline, and flattened the terrain the car was supposed to jump off.
		for ( const seed of [ 1, 7, SEED, 4242 ] ) {

			const field = createHeightField( { seed } );
			const land = sampleGrid( field, 80 ).filter( ( sample ) => sample.height > field.seaLevel );
			const above = ( threshold ) =>
				land.filter( ( sample ) => sample.height > threshold ).length / land.length;

			const heights = land.map( ( sample ) => sample.height ).sort( ( a, b ) => a - b );
			const median = heights[ Math.floor( heights.length / 2 ) ];

			expect( land.length ).toBeGreaterThan( 500 );

			// The bulk of the land is the grassy lowland around `baseHeight`.
			expect( median ).toBeLessThan( WORLD.baseHeight + 20 );
			expect( median ).toBeGreaterThan( WORLD.baseHeight * 0.5 );

			// Rock and snow belong to the hillsides and hilltops, not to the whole island.
			expect( above( ISLAND.grassHeight ) ).toBeLessThan( 0.45 );
			expect( above( ISLAND.snowHeight ) ).toBeLessThan( 0.2 );

			// ...but there are real hills to drive over, and to fly off.
			expect( above( ISLAND.grassHeight ) ).toBeGreaterThan( 0.05 );
			expect( heights[ heights.length - 1 ] ).toBeGreaterThan( ISLAND.snowHeight + 5 );

		}

	} );

	it( 'reports a normalized, upward surface normal', () => {

		const field = createHeightField( { seed: SEED } );
		const normal = field.normalAt( 120, - 260 );

		expect( Math.hypot( normal.x, normal.y, normal.z ) ).toBeCloseTo( 1, 6 );
		expect( normal.y ).toBeGreaterThan( 0 );

		// The finite differences must agree with the analytic slope helper.
		expect( field.slopeAt( 120, - 260 ) ).toBeGreaterThanOrEqual( 0 );

	} );

	it( 'reports the depth of the sea', () => {

		const field = createHeightField( { seed: SEED } );

		// Well out to sea, and inland.
		expect( field.waterDepthAt( field.radius * 1.4, 0 ) ).toBeGreaterThan( 10 );
		expect( field.waterDepthAt( 0, 0 ) ).toBeLessThan( 0 );

	} );

	it( 'finds a spawn point on dry, gentle land for many seeds', () => {

		for ( let i = 0; i < 100; i ++ ) {

			const seed = i * 7919 + 1;
			const field = createHeightField( { seed } );
			const spawn = field.findSpawnPoint();

			expect( Number.isFinite( spawn.x ) ).toBe( true );
			expect( Number.isFinite( spawn.z ) ).toBe( true );

			// Inside the island, above the water, and not on a cliff face.
			expect( Math.hypot( spawn.x, spawn.z ) ).toBeLessThan( field.radius );
			expect( spawn.height ).toBeGreaterThan( field.seaLevel + field.waterLevel );
			expect( field.isLand( spawn.x, spawn.z ) ).toBe( true );
			expect( spawn.slope ).toBeLessThan( 0.9 );

		}

	} );

	it( 'prefers a spawn point that is comfortably above the waterline', () => {

		let aboveWater = 0;

		for ( let i = 0; i < 60; i ++ ) {

			const field = createHeightField( { seed: i * 104729 + 3 } );
			const spawn = field.findSpawnPoint();

			if ( spawn.height > field.seaLevel + 2 ) aboveWater ++;

		}

		// The fallback path may occasionally land lower, but the vast majority of islands
		// must put the car well clear of the beach.
		expect( aboveWater ).toBeGreaterThan( 55 );

	} );

	it( 'reports the same spawn point regardless of other random consumers', () => {

		const a = createHeightField( { seed: SEED } ).findSpawnPoint();
		const field = createHeightField( { seed: SEED } );

		// Draw some random numbers in between: the spawn must not depend on them.
		for ( let i = 0; i < 25; i ++ ) field.heightAt( i, i );

		const b = field.findSpawnPoint();

		expect( b ).toEqual( a );

	} );

} );
