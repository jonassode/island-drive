import { describe, expect, it } from 'vitest';
import { createHeightField } from '../src/world/heightfield.js';
import { createProps } from '../src/world/props.js';
import { createPropSpots, isPropSuitable, keepClearOfSpawn, toTreeRegistry } from '../src/game/propSpots.js';
import { PROPS } from '../src/config.js';

/** Seeds that cover the pinned regression islands plus a couple of others. */
const SEEDS = [ 1, 7, 99, 12345 ];

describe( 'propSpots', () => {

	it( 'places trees and rocks on land, inside the prop band', () => {

		const field = createHeightField( { seed: 7 } );
		const { treeSpots, rockSpots } = createPropSpots( field );

		// `trees` is a target rather than a guarantee: the placement gives up after a capped number
		// of attempts, so a small or bumpy island tops out a little short.
		expect( treeSpots.length ).toBeGreaterThan( PROPS.trees * 0.5 );
		expect( treeSpots.length ).toBeLessThanOrEqual( PROPS.trees );
		expect( rockSpots.length ).toBeGreaterThan( 0 );
		expect( rockSpots.length ).toBeLessThanOrEqual( PROPS.rocks );

		// A tree is planted around a clump centre, so the band applies to the centre: individual
		// trees can stand a clump radius either side of it.
		const inner = PROPS.minRadius * field.radius - PROPS.clusterRadiusMax;
		const outer = PROPS.maxRadius * field.radius + PROPS.clusterRadiusMax;

		for ( const spot of [ ...treeSpots, ...rockSpots ] ) {

			expect( field.isLand( spot.x, spot.z ) ).toBe( true );

			const distance = Math.hypot( spot.x, spot.z );
			expect( distance ).toBeGreaterThanOrEqual( inner );
			expect( distance ).toBeLessThanOrEqual( outer );

		}

	} );

	it( 'keeps the car spawn area clear of scenery', () => {

		const field = createHeightField( { seed: 3 } );
		const { spawn, treeSpots, rockSpots } = createPropSpots( field );

		for ( const spot of [ ...treeSpots, ...rockSpots ] ) {

			expect( Math.hypot( spot.x - spawn.x, spot.z - spawn.z ) )
				.toBeGreaterThan( PROPS.spawnClearance );

		}

	} );

	it( 'is reproducible: the same seed places the same scenery', () => {

		const a = createPropSpots( createHeightField( { seed: 42 } ) ).treeSpots;
		const b = createPropSpots( createHeightField( { seed: 42 } ) ).treeSpots;

		expect( a.length ).toBe( b.length );
		expect( a[ 0 ] ).toEqual( b[ 0 ] );
		expect( a[ a.length - 1 ] ).toEqual( b[ b.length - 1 ] );

	} );

	it( 'reserves a PRNG stream of its own, so trees do not depend on the rocks', () => {

		// Same island, but the rocks asked for are changed: the trees must not move, because
		// trees are drawn from the stream *first*. This is the property the server relies on
		// when it only needs the trees.
		const field = createHeightField( { seed: 11 } );
		const full = createPropSpots( field ).treeSpots;
		const fewer = createPropSpots( field, { rocks: 10 } ).treeSpots;

		expect( fewer ).toEqual( full );

	} );

	it( 'accepts terrain only inside the height and slope rules', () => {

		const field = createHeightField( { seed: 7 } );
		const rules = { ...PROPS, minHeight: 8, maxHeight: 20, maxSlope: 0.3 };

		for ( let i = 0; i < 400; i ++ ) {

			const angle = ( i / 400 ) * Math.PI * 2;
			const x = Math.cos( angle ) * 400;
			const z = Math.sin( angle ) * 400;

			const suitable = isPropSuitable( field, rules, x, z );

			if ( suitable === false ) continue;

			const height = field.heightAt( x, z );
			expect( height ).toBeGreaterThanOrEqual( rules.minHeight );
			expect( height ).toBeLessThanOrEqual( rules.maxHeight );
			expect( field.slopeAt( x, z ) ).toBeLessThanOrEqual( rules.maxSlope );

		}

	} );

	it( 'keeps spots outside a clearance circle', () => {

		const clear = keepClearOfSpawn( { x: 100, z: - 50 }, 30 );

		expect( clear( { x: 100, z: - 50 } ) ).toBe( false );
		expect( clear( { x: 130.5, z: - 50 } ) ).toBe( true );
		expect( clear( { x: 100, z: - 19.5 } ) ).toBe( true );

	} );

	it( 'numbers the tree registry the way the meshes are instanced', () => {

		const field = createHeightField( { seed: 5 } );
		const { treeSpots, config } = createPropSpots( field );
		const registry = toTreeRegistry( treeSpots, config );

		expect( registry.length ).toBe( treeSpots.length );

		registry.forEach( ( tree, index ) => {

			expect( tree.index ).toBe( index );
			expect( tree.x ).toBe( treeSpots[ index ].x );
			expect( tree.z ).toBe( treeSpots[ index ].z );
			expect( tree.y ).toBe( treeSpots[ index ].height );
			expect( tree.alive ).toBe( true );

		} );

	} );

	it( 'gives the server the same trees the renderer draws', () => {

		// The load-bearing test of the whole multiplayer design: the client draws `props.trees`
		// and the server collides against its own registry, built separately with no meshes at
		// all. If these ever disagree, one side is driving through trees the other sees.
		for ( const seed of SEEDS ) {

			const field = createHeightField( { seed } );
			const props = createProps( field );
			const { config, treeSpots } = createPropSpots( field );
			const serverSide = toTreeRegistry( treeSpots, config );

			expect( serverSide.length ).toBe( props.trees.length );
			expect( props.treeCount ).toBe( props.trees.length );

			props.trees.forEach( ( tree, index ) => {

				const other = serverSide[ index ];

				expect( other.x ).toBe( tree.x );
				expect( other.z ).toBe( tree.z );
				expect( other.y ).toBe( tree.y );
				expect( other.index ).toBe( tree.index );
				expect( other.radius ).toBe( tree.radius );
				expect( other.crownRadius ).toBe( tree.crownRadius );

			} );

		}

	} );

} );