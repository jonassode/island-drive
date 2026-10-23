/**
 * Builds the visible dirt path from a {@link createPathField path field}.
 *
 * The ribbon reads the height field exactly like the terrain mesh does — one `heightAt()`
 * sample per vertex — so it climbs the same hills and drops into the same dips the car
 * drives over. It is lifted by a hair (`PATH.lift`) to clear the terrain triangles' linear
 * interpolation, crowned along its centre so it does not read as a flat decal, and its edges
 * fade to transparent so the dirt blends into the grass instead of ending in a hard,
 * obviously procedural line.
 *
 * A note on the trees: the loop is deliberately *not* kept clear of them. It is meant to run
 * under the canopy, and a tree standing in the track is an obstacle in the one place the
 * player is most likely to be driving, which the existing tree collision already handles.
 */

import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial } from 'three';
import { COLORS, PATH } from '../config.js';
import { createPathField } from './pathField.js';

// Band colours and a scratch instance are hoisted out of the vertex loop, exactly as in
// `island.js`: tens of thousands of transient colours would otherwise be allocated per island.
const DIRT_COLOR = new Color( COLORS.dirt );
const DIRT_DARK = new Color( COLORS.dirtDark );
const SCRATCH = new Color();

/**
 * Cheap deterministic hash in [0, 1), the same one the terrain colouring uses, so the dirt
 * varies on the same scale as the ground around it.
 *
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {number} Hash value in [0, 1).
 */
function hash2d( x, z ) {

	const value = Math.sin( x * 12.9898 + z * 78.233 ) * 43758.5453;
	return value - Math.floor( value );

}

/**
 * Smooth Hermite interpolation between two edges.
 *
 * @param {number} edge0 Lower edge.
 * @param {number} edge1 Upper edge.
 * @param {number} x Value to map.
 * @returns {number} Interpolated value in [0, 1].
 */
function smoothstep( edge0, edge1, x ) {

	const t = Math.min( 1, Math.max( 0, ( x - edge0 ) / ( edge1 - edge0 ) ) );
	return t * t * ( 3 - 2 * t );

}
/**
 * Creates the dirt path mesh.
 *
 * @param {object} heightField The terrain to lay the path on.
 * @param {object} [options] Layout options.
 * @param {object} [options.pathField] An existing path field to build from. Supplied by the
 *   caller when it wants to keep a reference (or to test the two halves separately);
 *   otherwise one is created from `options`.
 * @param {number} [options.crossSegments] Samples across the ribbon.
 * @returns {{ group: Group, mesh: Mesh, pathField: object, dispose: () => void }} The path.
 */
export function createPath( heightField, options = {} ) {

	const config = { ...PATH, ...options };
	const pathField = options.pathField ?? createPathField( heightField, options );

	const points = pathField.points;
	const stations = points.length;
	// One extra vertex per station closes the strip across its full width.
	const ring = config.crossSegments + 1;

	const positions = new Float32Array( stations * ring * 3 );
	const colors = new Float32Array( stations * ring * 4 );
	const indices = new Uint32Array( stations * config.crossSegments * 6 );

	let vertex = 0;
	let index = 0;

	for ( let i = 0; i < stations; i ++ ) {

		const point = points[ i ];
		const previous = points[ ( i - 1 + stations ) % stations ];
		const next = points[ ( i + 1 ) % stations ];

		// The loop's tangent, then its perpendicular. `side` points away from the island
		// centre, which is the direction the triangle winding below assumes.
		const tangentX = next.x - previous.x;
		const tangentZ = next.z - previous.z;
		const scale = 1 / ( Math.hypot( tangentX, tangentZ ) || 1 );
		const sideX = tangentZ * scale;
		const sideZ = - tangentX * scale;

		for ( let j = 0; j < ring; j ++ ) {

			// -1 is the inner edge of the dirt, 0 the centre, 1 the outer edge.
			const across = ( j / config.crossSegments ) * 2 - 1;
			const edge = Math.abs( across );

			const x = point.x + sideX * across * point.width;
			const z = point.z + sideZ * across * point.width;

			// Laid on the ground it is drawn on, from the same height field the car samples.
			// The crown puts the ribbon's edges — where the alpha reaches zero — down against
			// the terrain, which is where a gap between the two would be visible.
			const height = heightField.heightAt( x, z ) + config.lift + config.crown * ( 1 - edge * edge );

			positions[ vertex * 3 ] = x;
			positions[ vertex * 3 + 1 ] = height;
			positions[ vertex * 3 + 2 ] = z;

			const tint = 1 + ( hash2d( x, z ) - 0.5 ) * 2 * config.colorVariation;
			// Caked, darker earth towards the edge of the tread. The darkening is aimed at the
			// *solid* part of the ribbon rather than its fading rim, because the outermost
			// vertex is the one place the alpha has already gone to zero — dirt drawn there is
			// invisible, so shading it would only waste the darkening.
			const solid = 1 - config.edgeFade;
			SCRATCH.copy( DIRT_COLOR ).lerp( DIRT_DARK, smoothstep( solid * 0.5, solid, edge ) ).multiplyScalar( tint );

			colors[ vertex * 4 ] = SCRATCH.r;
			colors[ vertex * 4 + 1 ] = SCRATCH.g;
			colors[ vertex * 4 + 2 ] = SCRATCH.b;
			// The outer `edgeFade` of the width fades out, so there is no hard edge to spot.
			colors[ vertex * 4 + 3 ] = 1 - smoothstep( 1 - config.edgeFade, 1, edge );

			vertex ++;

		}

	}
// Two triangles per station / cross pair, wrapping the last station back to the first so
	// the strip closes into a loop instead of ending in a seam.
	for ( let i = 0; i < stations; i ++ ) {

		const following = ( i + 1 ) % stations;

		for ( let j = 0; j < config.crossSegments; j ++ ) {

			const a = i * ring + j;
			const b = following * ring + j;
			const c = following * ring + j + 1;
			const d = i * ring + j + 1;

			indices[ index ++ ] = a;
			indices[ index ++ ] = b;
			indices[ index ++ ] = c;

			indices[ index ++ ] = a;
			indices[ index ++ ] = c;
			indices[ index ++ ] = d;

		}

	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( positions, 3 ) );
	// Four components: the alpha is what fades the dirt into the terrain at its edges.
	geometry.setAttribute( 'color', new BufferAttribute( colors, 4 ) );
	geometry.setIndex( new BufferAttribute( indices, 1 ) );
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();

	const material = new MeshStandardMaterial( {
		vertexColors: true,
		roughness: 0.97,
		metalness: 0,
		transparent: true,
		// Does not write depth. The ribbon is a single non-overlapping sheet, so it never has
		// to occlude anything, and staying out of the depth buffer keeps its fully faded rim
		// from clipping whatever is behind it along the coastline.
		depthWrite: false,
		// ...and is pulled a touch towards the camera in the depth test, on top of the lift,
		// so the dirt and the terrain cannot flicker against each other on a steep face.
		polygonOffset: true,
		polygonOffsetFactor: - 1,
		polygonOffsetUnits: - 1,
	} );

	const mesh = new Mesh( geometry, material );
	mesh.name = 'path';
	mesh.receiveShadow = true;
	// Not a shadow caster: it lies flat on the very ground it would be casting onto, which is
	// the textbook recipe for shadow acne.
	mesh.castShadow = false;

	const group = new Group();
	group.name = 'path-group';
	group.add( mesh );

	return {
		group,
		mesh,
		pathField,
		dispose() {

			geometry.dispose();
			material.dispose();

		},
	};

}