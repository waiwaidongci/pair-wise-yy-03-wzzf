import { Canvas, type ThreeEvent, useThree } from '@react-three/fiber'
import { Grid, OrbitControls, PerspectiveCamera, Stats, TransformControls, useCursor } from '@react-three/drei'
import { Leva, useControls } from 'leva'
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import type { SceneObject } from '../types/scene'
import { useEditorStore } from '../stores/editor'
import { isGeometry, TYPE_LABELS, worldMatrix } from '../utils/scene'
import {
  BATCH_CHUNK_SIZE,
  BATCH_INSTANCE_THRESHOLD,
  captureSnapshot,
  lastGoodSnapshot,
  resolveInstance,
  type ResolvedNode,
} from '../utils/components'
import Geometry from './Geometry'

interface Registry {
  current: Map<string, THREE.Object3D>
}

/** 渲染失败后恢复现场：恢复到最近一次成功渲染的快照 */
class RenderGuard extends Component<{ children: ReactNode; onRestore?: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error('渲染失败，正在恢复现场', error)
    const snapshot = lastGoodSnapshot
    if (snapshot) {
      useEditorStore.setState({ objects: snapshot.objects, components: snapshot.components })
    }
    useEditorStore.getState().noticeMessage('渲染失败，已恢复到上一个正常场景')
    this.props.onRestore?.()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

function GeometryMesh({ object, registry, selectId }: { object: SceneObject; registry: Registry; selectId?: string }) {
  const select = useEditorStore((state) => state.select)
  const [hovered, setHovered] = useState(false)
  useCursor(hovered)
  const meshRef = useRef<THREE.Mesh>(null!)

  useEffect(() => {
    if (meshRef.current) registry.current.set(object.id, meshRef.current)
    return () => { registry.current.delete(object.id) }
  }, [object.id, registry])

  function handlePointer(event: ThreeEvent<MouseEvent>) {
    event.stopPropagation()
    select(selectId ?? object.id)
  }

  return (
    <mesh
      ref={meshRef}
      castShadow={object.castShadow}
      receiveShadow={object.receiveShadow}
      visible={object.visible}
      onClick={handlePointer}
      onPointerOver={(event) => { event.stopPropagation(); setHovered(true) }}
      onPointerOut={() => setHovered(false)}
    >
      <Geometry type={object.type} />
      <meshStandardMaterial
        color={object.material.color}
        roughness={object.material.roughness}
        metalness={object.material.metalness}
        transparent={object.material.opacity < 1}
        opacity={object.material.opacity}
        wireframe={object.material.wireframe}
        emissive={hovered ? '#1d4ed8' : '#000000'}
        emissiveIntensity={hovered ? 0.08 : 0}
      />
    </mesh>
  )
}

function LightObject({ object, registry, selectId }: { object: SceneObject; registry: Registry; selectId?: string }) {
  const select = useEditorStore((state) => state.select)
  const groupRef = useRef<THREE.Group>(null!)
  useEffect(() => {
    if (groupRef.current) registry.current.set(object.id, groupRef.current)
    return () => { registry.current.delete(object.id) }
  }, [object.id, registry])

  const common = {
    color: object.material.color,
    intensity: object.intensity ?? 1,
    castShadow: object.castShadow,
  }

  return (
    <group ref={groupRef} position={object.position} rotation={object.rotation} onClick={(event) => { event.stopPropagation(); select(selectId ?? object.id) }}>
      {object.type === 'directionalLight' && <directionalLight {...common} />}
      {object.type === 'pointLight' && <pointLight {...common} distance={object.distance} />}
      {object.type === 'spotLight' && <spotLight {...common} distance={object.distance} angle={0.45} penumbra={0.35} />}
      <mesh scale={0.12}>
        <octahedronGeometry />
        <meshBasicMaterial color={object.material.color} />
      </mesh>
    </group>
  )
}

function CameraObject({ object, registry, selectId }: { object: SceneObject; registry: Registry; selectId?: string }) {
  const select = useEditorStore((state) => state.select)
  const cameraRef = useRef<THREE.PerspectiveCamera>(null!)
  useEffect(() => {
    if (cameraRef.current) registry.current.set(object.id, cameraRef.current)
    return () => { registry.current.delete(object.id) }
  }, [object.id, registry])
  return (
    <group position={object.position} rotation={object.rotation} onClick={(event) => { event.stopPropagation(); select(selectId ?? object.id) }}>
      <PerspectiveCamera ref={cameraRef} makeDefault={object.activeCamera} fov={object.fov ?? 50} near={0.1} far={1000} />
      <mesh scale={0.25}>
        <boxGeometry args={[0.8, 0.55, 0.7]} />
        <meshBasicMaterial color="#0ea5e9" wireframe />
      </mesh>
    </group>
  )
}

/** 渲染解析后的组合件节点树；selectId 用于把整棵实例子树的拾取归到实例对象上 */
function ResolvedNodeView({ node, registry, selectId, registerId }: {
  node: ResolvedNode
  registry: Registry
  selectId?: string
  registerId?: string
}) {
  const object = node.object
  const groupRef = useRef<THREE.Group>(null!)
  useEffect(() => {
    if (registerId && groupRef.current) registry.current.set(registerId, groupRef.current)
    return () => { if (registerId) registry.current.delete(registerId) }
  }, [registerId, registry])

  const isLight = object.type.includes('Light')
  const isCamera = object.type === 'camera'
  return (
    <group ref={groupRef} position={object.position} rotation={object.rotation} scale={object.scale}>
      {isGeometry(object.type) && <GeometryMesh object={object} registry={registry} selectId={selectId} />}
      {isCamera && <CameraObject object={object} registry={registry} selectId={selectId} />}
      {!isGeometry(object.type) && !isCamera && <LightObject object={object} registry={registry} selectId={selectId} />}
      {node.children.map((child, index) => (
        <ResolvedNodeView key={index} node={child} registry={registry} selectId={selectId} />
      ))}
    </group>
  )
}

/** 引用实例：解析源组合件模板并渲染，覆盖项使用实例自身的值 */
function ResolvedInstance({ object, registry }: { object: SceneObject; registry: Registry }) {
  const components = useEditorStore((state) => state.components)
  const resolved = useMemo(() => resolveInstance(object, components), [object, components])
  return <ResolvedNodeView node={resolved} registry={registry} selectId={object.id} registerId={object.id} />
}

function ObjectView({ object, objects, registry }: { object: SceneObject; objects: SceneObject[]; registry: Registry }) {
  const children = objects.filter((item) => item.parentId === object.id)

  if (object.componentId) {
    return <ResolvedInstance object={object} registry={registry} />
  }

  if (isGeometry(object.type) || object.parentId) {
    return (
      <group position={object.position} rotation={object.rotation} scale={object.scale}>
        {isGeometry(object.type) && <GeometryMesh object={object} registry={registry} />}
        {object.type === 'camera' && <CameraObject object={object} registry={registry} />}
        {!isGeometry(object.type) && object.type !== 'camera' && <LightObject object={object} registry={registry} />}
        {children.map((child) => <ObjectView key={child.id} object={child} objects={objects} registry={registry} />)}
      </group>
    )
  }
  return (
    <>
      <LightObject object={object} registry={registry} />
      <group position={object.position} rotation={object.rotation} scale={object.scale}>
        {children.map((child) => <ObjectView key={child.id} object={child} objects={objects} registry={registry} />)}
      </group>
    </>
  )
}

function SelectionControls({ registry }: { registry: Registry }) {
  const selectedId = useEditorStore((state) => state.selectedId)
  const mode = useEditorStore((state) => state.transformMode)
  const snapEnabled = useEditorStore((state) => state.snapEnabled)
  const snapSize = useEditorStore((state) => state.snapSize)
  const setTransform = useEditorStore((state) => state.setTransform)
  const [, refresh] = useState(0)

  useEffect(() => {
    const timer = window.setTimeout(() => refresh((value) => value + 1), 0)
    return () => window.clearTimeout(timer)
  }, [selectedId])

  const object = selectedId ? registry.current.get(selectedId) : undefined
  if (!object || !selectedId) return null
  const activeId = selectedId

  function commit() {
    if (!object) return
    setTransform(activeId, {
      position: object.position.toArray() as [number, number, number],
      rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
      scale: object.scale.toArray() as [number, number, number],
    })
  }

  return (
    <TransformControls
      object={object}
      mode={mode}
      translationSnap={snapEnabled ? snapSize : null}
      rotationSnap={snapEnabled ? Math.PI / 12 : null}
      scaleSnap={snapEnabled ? 0.1 : null}
      onMouseUp={commit}
    />
  )
}

function InstanceBatch({ type, objects, registry }: { type: SceneObject['type']; objects: SceneObject[]; registry: Registry }) {
  const select = useEditorStore((state) => state.select)
  const ref = useRef<THREE.InstancedMesh>(null!)
  const matrices = useMemo(() => {
    const cache = new Map<string, THREE.Matrix4>()
    return objects.map((object) => worldMatrix(object.id, useEditorStore.getState().objects, cache))
  }, [objects])

  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    matrices.forEach((matrix, index) => {
      mesh.setMatrixAt(index, matrix)
      mesh.setColorAt(index, new THREE.Color(objects[index].material.color))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    registry.current.set(`instance-${type}`, mesh)
  }, [matrices, objects, registry, type])

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, objects.length]}
      castShadow
      receiveShadow
      frustumCulled={false}
      onClick={(event) => {
        event.stopPropagation()
        const index = event.instanceId
        if (index !== undefined) select(objects[index].id)
      }}
    >
      <Geometry type={type} />
      <meshStandardMaterial vertexColors roughness={0.48} metalness={0.04} />
    </instancedMesh>
  )
}

/** 引用实例数量较多时，按批逐帧渲染，避免一次性提交卡死；失败由 RenderGuard 恢复现场 */
function BatchedInstances({ instances, registry }: { instances: SceneObject[]; registry: Registry }) {
  const [visibleCount, setVisibleCount] = useState(BATCH_CHUNK_SIZE)
  useEffect(() => {
    if (visibleCount >= instances.length) return
    const id = requestAnimationFrame(() => {
      setVisibleCount((count) => Math.min(count + BATCH_CHUNK_SIZE, instances.length))
    })
    return () => cancelAnimationFrame(id)
  }, [visibleCount, instances.length])

  const shown = instances.slice(0, visibleCount)
  return <>{shown.map((object) => <ObjectView key={object.id} object={object} objects={instances} registry={registry} />)}</>
}

function SceneRoots({ objects, registry }: { objects: SceneObject[]; registry: Registry }) {
  const roots = objects.filter((object) => !object.parentId)
  const instanceRoots = roots.filter((object) => object.componentId)
  const normalRoots = roots.filter((object) => !object.componentId)
  const many = instanceRoots.length > BATCH_INSTANCE_THRESHOLD
  return (
    <>
      {normalRoots.map((object) => <ObjectView key={object.id} object={object} objects={objects} registry={registry} />)}
      {many
        ? <BatchedInstances instances={instanceRoots} registry={registry} />
        : instanceRoots.map((object) => <ObjectView key={object.id} object={object} objects={objects} registry={registry} />)}
    </>
  )
}

function InstancedScene({ objects, registry }: { objects: SceneObject[]; registry: Registry }) {
  const batches = useMemo(() => {
    const map = new Map<SceneObject['type'], SceneObject[]>()
    objects
      .filter((object) => isGeometry(object.type) && object.visible && !object.componentId)
      .forEach((object) => {
        map.set(object.type, [...(map.get(object.type) ?? []), object])
      })
    return [...map.entries()]
  }, [objects])
  const singleObjects = objects.filter((object) => !isGeometry(object.type) && !object.parentId && !object.componentId)
  const instanceRoots = objects.filter((object) => !object.parentId && object.componentId)
  const many = instanceRoots.length > BATCH_INSTANCE_THRESHOLD
  return (
    <>
      {batches.map(([type, batch]) => <InstanceBatch key={type} type={type} objects={batch} registry={registry} />)}
      {singleObjects.map((object) => <ObjectView key={object.id} object={object} objects={objects} registry={registry} />)}
      {many
        ? <BatchedInstances instances={instanceRoots} registry={registry} />
        : instanceRoots.map((object) => <ObjectView key={object.id} object={object} objects={objects} registry={registry} />)}
    </>
  )
}

function SceneContent({ registry }: { registry: Registry }) {
  const objects = useEditorStore((state) => state.objects)
  const components = useEditorStore((state) => state.components)
  const performance = useEditorStore((state) => state.performance)
  const showGrid = performance.showGrid

  // 每次成功渲染后捕获现场快照，供渲染失败时恢复
  useEffect(() => {
    captureSnapshot(objects, components)
  }, [objects, components])

  return (
    <>
      <color attach="background" args={['#cdd7e5']} />
      <fog attach="fog" args={['#cdd7e5', 18, 55]} />
      <ambientLight intensity={0.7} />
      {showGrid && <Grid infiniteGrid cellSize={0.5} sectionSize={2.5} fadeDistance={32} sectionColor="#7b8da5" cellColor="#b5c0cf" />}
      {performance.instanceMode ? (
        <InstancedScene objects={objects} registry={registry} />
      ) : (
        <SceneRoots objects={objects} registry={registry} />
      )}
      {!performance.instanceMode && <SelectionControls registry={registry} />}
    </>
  )
}

function RenderControls() {
  const controls = useControls('渲染性能', () => ({
    exposure: { value: 1.05, min: 0.2, max: 2.5, step: 0.05 },
    showStats: true,
  })) as unknown as { exposure: number; showStats: boolean }
  const gl = useThree((state) => state.gl)
  useEffect(() => { gl.toneMappingExposure = controls.exposure }, [controls.exposure, gl])
  return controls.showStats ? <Stats /> : null
}

export default function SceneViewport() {
  const registry = useRef<Map<string, THREE.Object3D>>(new Map())
  const performance = useEditorStore((state) => state.performance)
  const [guardKey, setGuardKey] = useState(0)
  return (
    <div className="viewport-wrap">
      <Canvas
        camera={{ position: [6, 5, 8], fov: 48 }}
        shadows={performance.shadows}
        dpr={performance.instanceMode ? [0.7, 1] : [1, performance.pixelRatio]}
        gl={{ antialias: !performance.instanceMode, powerPreference: 'high-performance' }}
      >
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={2} maxDistance={45} />
        <RenderGuard key={guardKey} onRestore={() => setGuardKey((key) => key + 1)}>
          <SceneContent registry={registry} />
        </RenderGuard>
        <RenderControls />
      </Canvas>
      <Leva collapsed titleBar={{ title: '视图控制' }} />
    </div>
  )
}
