/**
 * The ocean the island sits in.
 *
 * Deliberately *not* `three/addons/objects/Water.js`: that addon needs
 * `examples/textures/waternormals.jpg`, which is not part of the published npm package,
 * so it would 404. A gently animated grid gives the same impression with no assets.
 */

import { BufferAttribute, Group, Mesh, MeshStandardMaterial, PlaneGeometry } from 'three';
import { COLORS, WATER, WORLD } from '../config.js';

/** Two pi, used to convert wavelengths into wave numbers. */
const TAU = Math.PI * 2;

/**
 * Pre-computes the wave numbers of the configured wave trains.
 *
 * @returns {Array<{amplitude: number, k: number, speed: number, dirX: number, dirZ: number}>} Waves.
 */
function prepareWaves() {

	return WATER.waves.map( ( wave ) => {

		const k = TAU / wave.wavelength;
		const length = Math.hypot( wave.dirX, wave.dirZ ) || 1;

		return {
			amplitude: wave.amplitude,
			k,
			speed: wave.speed,
			dirX: wave.dirX / length,
			dirZ: wave.dirZ / length,
		};

	} );

}

/**
 * Creates the ocean: an animated surface plus a deep sea floor.
 *
 * The sea floor matters: without it, the rim of the square terrain grid is visible through
 * the translucent water as a lighter square. A plane below the terrain's submerged rim
 * hides that seam and makes the shallows fade naturally into deep water.
 *
 * The surface is a grid whose vertices are displaced by a few sine waves. Its normals are
 * derived analytically from those same waves rather than with `computeVertexNormals()`,
 * which on a grid this big would re-average 10k+ triangles every single frame.
 *
 * @param {object} [config] World configuration (size / resolution / water level).
 * @returns {{ group: Group, update: (elapsed: number) => void, dispose: () => void }} The ocean.
 */
export function createWater( config = WORLD ) {

	const group = new Group();
	group.name = 'ocean';

	const geometries = [];
	const materials = [];
	const waves = prepareWaves();

	// --- sea floor ------------------------------------------------------------------
	const seabedGeometry = new PlaneGeometry(
		config.waterSize * WATER.seabedScale,
		config.waterSize * WATER.seabedScale,
	);
	seabedGeometry.rotateX( - Math.PI / 2 );

	const seabedMaterial = new MeshStandardMaterial( {
		color: COLORS.seabed,
		roughness: 1,
		metalness: 0,
	} );

	const seabed = new Mesh( seabedGeometry, seabedMaterial );
	seabed.name = 'seabed';
	seabed.position.y = config.seabedLevel;
	group.add( seabed );

	geometries.push( seabedGeometry );
	materials.push( seabedMaterial );

	// --- water surface ---------------------------------------------------------------
	const geometry = new PlaneGeometry(
		config.waterSize,
		config.waterSize,
		config.waterSegments,
		config.waterSegments,
	);

	// Bake the rotation so vertex (x, z) are already world coordinates.
	geometry.rotateX( - Math.PI / 2 );

	const position = geometry.attributes.position;
	const vertexCount = position.count;

	// Pristine copy of the flat grid, used as the wave sample point every frame.
	const base = Float32Array.from( position.array );
	const normals = new Float32Array( vertexCount * 3 );

	const material = new MeshStandardMaterial( {
		color: COLORS.water,
		roughness: 0.22,
		metalness: 0.08,
		transparent: true,
		opacity: 0.88,
	} );

	const mesh = new Mesh( geometry, material );
	mesh.name = 'water';
	// Deliberately *not* a shadow receiver. The ocean is a 7000 u plane while the shadow
	// frustum is only a couple of hundred units wide (it follows the car), so receiving
	// shadows would paint the frustum's square edge onto open water as a visible seam. The
	// car can never be shadowed onto water anyway: it respawns instead of floating.
	mesh.receiveShadow = false;
	mesh.renderOrder = 1;
	group.add( mesh );

	// Start flat and level, so the very first frame is already correct.
	for ( let i = 0; i < vertexCount; i ++ ) normals[ i * 3 + 1 ] = 1;
	geometry.setAttribute( 'normal', new BufferAttribute( normals, 3 ) );

	geometries.push( geometry );
	materials.push( material );

	return {
		group,
		update( elapsed ) {

			for ( let i = 0; i < vertexCount; i ++ ) {

				const x = base[ i * 3 ];
				const z = base[ i * 3 + 2 ];

				let height = config.waterLevel;
				let slopeX = 0;
				let slopeZ = 0;

				for ( let w = 0; w < waves.length; w ++ ) {

					const wave = waves[ w ];
					const phase = wave.k * ( wave.dirX * x + wave.dirZ * z ) + wave.speed * elapsed;
					const cosine = Math.cos( phase );

					height += wave.amplitude * Math.sin( phase );
					slopeX += wave.amplitude * wave.k * wave.dirX * cosine;
					slopeZ += wave.amplitude * wave.k * wave.dirZ * cosine;

				}

				position.setY( i, height );

				// Analytic normal of the height function: (-dh/dx, 1, -dh/dz), normalized.
				const length = Math.hypot( slopeX, 1, slopeZ );
				normals[ i * 3 ] = - slopeX / length;
				normals[ i * 3 + 1 ] = 1 / length;
				normals[ i * 3 + 2 ] = - slopeZ / length;

			}

			position.needsUpdate = true;
			geometry.attributes.normal.needsUpdate = true;

		},
		dispose() {

			for ( const item of geometries ) item.dispose();
			for ( const item of materials ) item.dispose();

		},
	};

}
