/**
 * Builds the visible terrain mesh from a {@link createHeightField height field}.
 *
 * The geometry only *reads* the height field, which means the rendered ground and the
 * surface the car samples are guaranteed to be the same surface.
 */

import { BufferAttribute, Color, Group, Mesh, MeshStandardMaterial, PlaneGeometry } from 'three';
import { COLORS, ISLAND } from '../config.js';

/** Colour the sea bed blends towards below the waterline. Matched to the sea floor plane
 * that {@link ./water.js} adds, so the edge of the terrain grid cannot be seen through the
 * translucent water. */
const SEA_BED = new Color( COLORS.seabed );
/** Second grass tone, blended in by a cheap hash so the island is not a flat colour. */
const GRASS_DARK = new Color( 0x3d7530 );

// Band colours and a scratch instance are hoisted out of the vertex loop to avoid
// allocating tens of thousands of transient colours while building the geometry.
const SAND_COLOR = new Color( COLORS.sand );
const GRASS_COLOR = new Color( COLORS.grass );
const ROCK_COLOR = new Color( COLORS.rock );
const SNOW_COLOR = new Color( COLORS.snow );
const SCRATCH = new Color();

/**
 * Cheap deterministic hash in [0, 1) used for per-vertex colour variation.
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
 * Terrain colour for a given height, blending sand -> grass -> rock -> snow.
 *
 * @param {number} height Terrain height.
 * @param {number} x World x.
 * @param {number} z World z.
 * @param {number} seaLevel World height of the ocean surface.
 * @param {{r:number,g:number,b:number}} out Colour to write into.
 * @returns {{r:number,g:number,b:number}} The resulting colour.
 */
function colorAt( height, x, z, seaLevel, out ) {

	const blend = ISLAND.blend;

	const toGrass = smoothstep( ISLAND.sandHeight - blend, ISLAND.sandHeight + blend, height );
	const toRock = smoothstep( ISLAND.grassHeight - blend, ISLAND.grassHeight + blend, height );
	const toSnow = smoothstep( ISLAND.snowHeight - blend, ISLAND.snowHeight + blend, height );

	const variation = hash2d( x, z );
	const grass = SCRATCH.copy( GRASS_COLOR ).lerp( GRASS_DARK, variation );

	out.copy( SAND_COLOR );
	out.lerp( grass, toGrass );
	out.lerp( ROCK_COLOR, toRock );
	out.lerp( SNOW_COLOR, toSnow );

	// Deep water is tinted towards the sea floor colour so the shallows fade into the deep,
	// and the rim of the terrain grid cannot be spotted through the translucent water.
	const wet = 1 - smoothstep( seaLevel - 14, seaLevel + 0.4, height );
	if ( wet > 0 ) out.lerp( SEA_BED, wet * 0.85 );

	// Slight per-vertex brightness variation keeps the surface from looking flat.
	const tint = 1 + ( variation - 0.5 ) * ISLAND.colorVariation * 2;
	out.multiplyScalar( tint );

	return out;

}

/**
 * Creates the island terrain mesh.
 *
 * @param {object} heightField The height field to sample.
 * @param {object} [options] Layout options.
 * @param {number} [options.size] Side length of the terrain grid.
 * @param {number} [options.segments] Grid resolution per side.
 * @returns {{ group: Group, mesh: Mesh, dispose: () => void }} The island.
 */
export function createIsland( heightField, options = {} ) {

	const size = options.size ?? heightField.size;
	const segments = options.segments ?? 384;

	const geometry = new PlaneGeometry( size, size, segments, segments );

	// Baking the rotation means every vertex is already at its final world (x, z),
	// so the height field can be sampled without any coordinate gymnastics.
	geometry.rotateX( - Math.PI / 2 );

	const position = geometry.attributes.position;
	const colors = new Float32Array( position.count * 3 );
	const color = new Color();
	const vertexCount = position.count;

	for ( let i = 0; i < vertexCount; i ++ ) {

		const x = position.getX( i );
		const z = position.getZ( i );
		const height = heightField.heightAt( x, z );

		position.setY( i, height );

		colorAt( height, x, z, heightField.seaLevel, color );
		colors[ i * 3 ] = color.r;
		colors[ i * 3 + 1 ] = color.g;
		colors[ i * 3 + 2 ] = color.b;

	}

	position.needsUpdate = true;

	geometry.setAttribute( 'color', new BufferAttribute( colors, 3 ) );
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();

	const material = new MeshStandardMaterial( {
		vertexColors: true,
		roughness: 0.96,
		metalness: 0,
	} );

	const mesh = new Mesh( geometry, material );
	mesh.name = 'island';
	mesh.receiveShadow = true;

	const group = new Group();
	group.name = 'island-group';
	group.add( mesh );

	return {
		group,
		mesh,
		dispose() {

			geometry.dispose();
			material.dispose();

		},
	};

}
