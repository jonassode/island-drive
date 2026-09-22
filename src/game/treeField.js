/**
 * A uniform grid over the tree registry, for fast "what is near the car?" queries.
 *
 * With a couple of thousand trees, a linear scan per frame would be wasteful, and a
 * physically accurate broad phase for a handful of circles would be overkill. A hash of
 * fixed size cells is the right middle ground: insertion is O(n) once per island, and a
 * query only visits the cells the car can possibly overlap.
 *
 * The grid stores *references* to the tree objects, so when `createProps()` marks a tree as
 * no longer alive, this index sees that immediately without any bookkeeping.
 *
 * This module is pure (no DOM, no three.js) so it can be unit tested headlessly.
 */

import { CAR } from '../config.js';

/**
 * Builds an index over a set of trees.
 *
 * @param {Array<{x: number, z: number, radius: number, alive: boolean}>} trees Trees to index.
 * @param {object} [options] Index options.
 * @param {number} [options.cellSize] Side length of a grid cell in world units.
 * @returns {{ queryNearby: Function, cellSize: number, cellCount: number, treeCount: number }} Index.
 */
export function createTreeField( trees, options = {} ) {

	const cellSize = options.cellSize ?? 60;
	const cells = new Map();

	/**
	 * Cell key. String keys keep negative coordinates trivially correct.
	 *
	 * @param {number} cellX Cell x.
	 * @param {number} cellZ Cell z.
	 * @returns {string} Key.
	 */
	function keyOf( cellX, cellZ ) {

		return `${cellX},${cellZ}`;

	}

	for ( let i = 0; i < trees.length; i ++ ) {

		const tree = trees[ i ];
		const key = keyOf( Math.floor( tree.x / cellSize ), Math.floor( tree.z / cellSize ) );

		const bucket = cells.get( key );

		if ( bucket === undefined ) cells.set( key, [ tree ] );
		else bucket.push( tree );

	}

	return {
		cellSize,
		cellCount: cells.size,
		treeCount: trees.length,

		/**
		 * Collects every living tree that could be within `radius` of a point.
		 *
		 * The caller must still do the precise distance test; this is a broad phase.
		 *
		 * @param {number} x World x.
		 * @param {number} z World z.
		 * @param {number} radius Query radius, in world units.
		 * @param {Array<object>} out Array to fill. It is truncated to the result length.
		 * @returns {number} Number of trees written into `out`.
		 */
		queryNearby( x, z, radius, out ) {

			const minCellX = Math.floor( ( x - radius ) / cellSize );
			const maxCellX = Math.floor( ( x + radius ) / cellSize );
			const minCellZ = Math.floor( ( z - radius ) / cellSize );
			const maxCellZ = Math.floor( ( z + radius ) / cellSize );

			let count = 0;

			for ( let cellX = minCellX; cellX <= maxCellX; cellX ++ ) {

				for ( let cellZ = minCellZ; cellZ <= maxCellZ; cellZ ++ ) {

					const bucket = cells.get( keyOf( cellX, cellZ ) );
					if ( bucket === undefined ) continue;

					for ( let i = 0; i < bucket.length; i ++ ) {

						const tree = bucket[ i ];

						if ( tree.alive === false ) continue;

						// Reject on the bounding circle first; the exact test is the caller's.
						const dx = tree.x - x;
						const dz = tree.z - z;
						const reach = radius + ( tree.radius ?? CAR.treeRadius );

						if ( dx * dx + dz * dz > reach * reach ) continue;

						out[ count ] = tree;
						count ++;

					}

				}

			}

			out.length = count;

			return count;

		},
	};

}