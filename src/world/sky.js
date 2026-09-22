/**
 * Sky dome, sun and ambient lighting.
 *
 * Uses the `Sky` addon (Preetham analytic daylight) and positions the directional light
 * along the very same sun vector, so the shadows always match the sky.
 */

import {
	DirectionalLight, Fog, HemisphereLight, PMREMGenerator, Scene, Vector3,
} from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { COLORS, SKY, WORLD } from '../config.js';

/**
 * Creates the sky, the sun, the ambient fill and the scene fog.
 *
 * The sky is also baked into an environment map (image based lighting), which is what
 * gives the car paint, the water and the metals something to reflect. Without it,
 * `metalness` surfaces render almost black.
 *
 * @param {object} scene Scene to populate.
 * @param {object} renderer Renderer, needed to bake the environment map.
 * @param {object} [config] World configuration (for the fog distances).
 * @returns {{ sun: DirectionalLight, focusShadow: (x: number, z: number) => void,
 *   update: (elapsed: number) => void, dispose: () => void }}
 */
export function createSky( scene, renderer, config = WORLD ) {

	const sky = new Sky();
	sky.scale.setScalar( SKY.scale );
	sky.name = 'sky';

	const uniforms = sky.material.uniforms;
	uniforms.turbidity.value = SKY.turbidity;
	uniforms.rayleigh.value = SKY.rayleigh;
	uniforms.mieCoefficient.value = SKY.mieCoefficient;
	uniforms.mieDirectionalG.value = SKY.mieDirectionalG;

	// Spherical -> cartesian sun position from elevation / azimuth in degrees.
	const phi = ( 90 - SKY.elevation ) * ( Math.PI / 180 );
	const theta = SKY.azimuth * ( Math.PI / 180 );
	const sunPosition = new Vector3().setFromSphericalCoords( 1, phi, theta );

	uniforms.sunPosition.value.copy( sunPosition );

	// Bake the sky into an environment map. The sky is temporarily parked in its own scene
	// for the capture, then moved into the real scene as the visible background.
	//
	// The sun disc is hidden for the bake: it is enormously bright (tens of thousands of
	// units), and leaving it in would flood the environment map and wash every surface out.
	// This is the documented purpose of the `showSunDisc` uniform.
	const environmentScene = new Scene();
	environmentScene.add( sky );

	uniforms.showSunDisc.value = 0;
	const pmrem = new PMREMGenerator( renderer );
	const environment = pmrem.fromScene( environmentScene );
	pmrem.dispose();
	uniforms.showSunDisc.value = 1;

	environmentScene.remove( sky );
	scene.add( sky );
	scene.environment = environment.texture;
	// The baked sky is bright; soften the ambient contribution so the terrain is not washed
	// out. Ignored harmlessly on revisions that predate `environmentIntensity`.
	scene.environmentIntensity = SKY.environmentIntensity;

	// Sun light: three.js r155+ uses physically correct light units, so an intensity of
	// around 3 reads as direct sunlight once ACES tone mapping is applied.
	const sun = new DirectionalLight( 0xffffff, SKY.sunIntensity );
	sun.position.copy( sunPosition ).multiplyScalar( SKY.sunDistance );
	sun.castShadow = true;
	sun.shadow.mapSize.set( SKY.shadowMapSize, SKY.shadowMapSize );
	// The shadow frustum follows the car instead of covering the whole island: a world this
	// big cannot fit into one 2048 shadow map, so only the area around the car is shadowed.
	// (The light is directional, so moving it does not change the lighting, only what casts
	// and receives shadows.)
	sun.shadow.camera.near = 1;
	sun.shadow.camera.far = SKY.sunDistance * 2.5;
	sun.shadow.bias = - 0.0005;
	sun.shadow.normalBias = 0.2;

	const extent = SKY.shadowExtent;
	sun.shadow.camera.left = - extent;
	sun.shadow.camera.right = extent;
	sun.shadow.camera.top = extent;
	sun.shadow.camera.bottom = - extent;
	sun.shadow.camera.updateProjectionMatrix();

	// Direction of the light, used to keep the sun rig parked over the car.
	const sunOffset = sunPosition.clone().multiplyScalar( SKY.sunDistance );

	sun.position.copy( sunOffset );
	scene.add( sun );
	scene.add( sun.target );

	// Ambient fill from the sky, so shadowed faces are not pitch black.
	const hemisphere = new HemisphereLight( 0xbfd9ff, 0x5a6b52, SKY.hemiIntensity );
	scene.add( hemisphere );

	// Haze that matches the horizon so distant water fades out instead of ending. The far
	// distance is deliberately inside the edge of the ocean planes, so the seam where they
	// stop is always lost in the haze.
	scene.fog = new Fog( COLORS.fog, config.fogNear, config.fogFar );

	return {
		sun,
		/**
		 * Keeps the shadow frustum centred on the car by moving the light and its target.
		 *
		 * @param {number} x World x.
		 * @param {number} z World z.
		 * @returns {void}
		 */
		focusShadow( x, z ) {

			sun.target.position.set( x, 0, z );
			sun.target.updateMatrixWorld();
			sun.position.set( x + sunOffset.x, sunOffset.y, z + sunOffset.z );
			sun.updateMatrixWorld();

		},
		update( elapsed ) {

			// Faint cloud drift. The uniform only exists in newer revisions of the addon.
			if ( uniforms.time !== undefined ) uniforms.time.value = elapsed;

		},
		dispose() {

			scene.remove( sky );
			scene.remove( sun );
			scene.remove( hemisphere );
			scene.environment = null;
			environment.dispose();
			sky.material.dispose();
			sky.geometry.dispose();
			sun.dispose();
			hemisphere.dispose();

		},
	};

}
