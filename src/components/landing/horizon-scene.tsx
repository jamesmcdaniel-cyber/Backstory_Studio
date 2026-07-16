'use client'

import { useRef } from 'react'
import { Canvas, useFrame, type ThreeElements } from '@react-three/fiber'
import { Icosahedron, MeshDistortMaterial, Float } from '@react-three/drei'
import type { Group } from 'three'

/**
 * The landing hero's WebGL centerpiece: a slowly rotating, gently distorted
 * icosahedron in the Horizon palette — a physical "horizon" object that catches
 * light and leans toward the cursor. Loaded only on the landing route (dynamic,
 * ssr:false) and only when motion is allowed; a CSS aurora stands in otherwise.
 *
 * Deliberately dependency-light on assets: no Environment/HDR (which would fetch
 * from a CDN and break offline/CSP) — just three lights in brand colors.
 */

function HorizonObject(props: ThreeElements['group']) {
  const group = useRef<Group>(null)
  useFrame((state, delta) => {
    const g = group.current
    if (!g) return
    // Steady spin plus a subtle lean toward the pointer (parallax).
    g.rotation.y += delta * 0.18
    g.rotation.x += (state.pointer.y * 0.25 - g.rotation.x) * 0.04
    g.rotation.z += (state.pointer.x * 0.15 - g.rotation.z) * 0.04
  })
  return (
    <group ref={group} {...props}>
      <Float speed={1.4} rotationIntensity={0.4} floatIntensity={0.8}>
        <Icosahedron args={[1.5, 8]}>
          <MeshDistortMaterial
            color="#447C93"
            emissive="#0A2F3F"
            emissiveIntensity={0.35}
            roughness={0.25}
            metalness={0.55}
            distort={0.32}
            speed={1.6}
          />
        </Icosahedron>
        {/* Faint wireframe shell adds structure without a second draw-heavy mesh. */}
        <Icosahedron args={[1.62, 2]}>
          <meshBasicMaterial color="#7DACC0" wireframe transparent opacity={0.12} />
        </Icosahedron>
      </Float>
    </group>
  )
}

export default function HorizonScene() {
  return (
    <Canvas
      camera={{ position: [0, 0, 5], fov: 42 }}
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true }}
      style={{ width: '100%', height: '100%' }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[4, 3, 5]} intensity={2.2} color="#DBEBF2" />
      <directionalLight position={[-5, -2, -3]} intensity={1.1} color="#18485C" />
      <pointLight position={[0, 2, 3]} intensity={12} color="#99C1D1" distance={12} />
      <HorizonObject scale={1} />
    </Canvas>
  )
}
