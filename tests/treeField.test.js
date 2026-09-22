import { describe, expect, it } from 'vitest';
import { createTreeField } from '../src/game/treeField.js';

/**
 * Builds a deterministic scatter of trees (a jittered grid).
 *
 * @param {number} count How many.
 * @param {number} extent Half extent of the area.
 * @returns {Array<object>} Trees.
 */
function scatter( count, extent = 400 ) {

	const trees = [];
	const side = Math.ceil( Math.sqrt( count ) );

	for ( let i = 0; i < count; i ++ ) {

		const gx = i % side;
		const gz = Math.floor( i / side );

		trees.push( {
			x: ( gx / side - 0.5 ) * 2 * extent,
			z: ( gz / side - 0.5 ) * 2 * extent,
			radius: 0.7,
			alive: true,
		} );

	}

	return trees;

}

describe( 'createTreeField', () => {

	it( 'indexes every tree', () => {

		const trees = scatter( 500 );
		const index = createTreeField( trees );

		expect( index.treeCount ).toBe( 500 );
		expect( index.cellCount ).toBeGreaterThan( 0 );

	} );

	it( 'returns only the trees inside the query radius', () => {

		const trees = scatter( 400, 200 );
		const index = createTreeField( trees, { cellSize: 40 } );
		const out = [];

		const found = index.queryNearby( 0, 0, 25, out );

		expect( found ).toBe( out.length );
		expect( found ).toBeGreaterThan( 0 );

		// The broad phase may return neighbours, but never anything out of range.
		for ( const tree of out ) {

			expect( Math.hypot( tree.x, tree.z ) ).toBeLessThanOrEqual( 25 + tree.radius + 1e-9 );

		}

	} );

	it( 'finds a lone tree far from the origin', () => {

		const trees = [ { x: - 812, z: 640, radius: 0.7, alive: true } ];
		const index = createTreeField( trees, { cellSize: 60 } );
		const out = [];

		expect( index.queryNearby( - 812, 640, 2, out ) ).toBe( 1 );
		expect( index.queryNearby( 0, 0, 2, out ) ).toBe( 0 );

	} );

	it( 'is correct across negative and positive cells', () => {

		const trees = [
			{ x: - 100, z: - 100, radius: 0.7, alive: true },
			{ x: 100, z: 100, radius: 0.7, alive: true },
		];

		const index = createTreeField( trees, { cellSize: 50 } );
		const out = [];

		expect( index.queryNearby( - 100, - 100, 1, out ) ).toBe( 1 );
		expect( index.queryNearby( 100, 100, 1, out ) ).toBe( 1 );
		expect( index.queryNearby( 0, 0, 10, out ) ).toBe( 0 );

	} );

	it( 'ignores trees that are no longer alive', () => {

		const trees = scatter( 50, 100 );
		const index = createTreeField( trees, { cellSize: 40 } );
		const out = [];

		const before = index.queryNearby( 0, 0, 200, out );
		expect( before ).toBeGreaterThan( 0 );

		// The grid holds references, so marking a tree dead is seen immediately.
		for ( const tree of trees ) tree.alive = false;

		expect( index.queryNearby( 0, 0, 200, out ) ).toBe( 0 );

	} );

	it( 'overwrites and truncates the output array', () => {

		const trees = scatter( 100, 100 );
		const index = createTreeField( trees, { cellSize: 40 } );
		const out = [ 'stale', 'stale', 'stale', 'stale' ];

		const found = index.queryNearby( 0, 0, 200, out );

		expect( out.length ).toBe( found );
		expect( out ).not.toContain( 'stale' );

	} );

} );