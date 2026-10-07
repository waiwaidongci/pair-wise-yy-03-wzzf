import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber'
import { Grid, OrbitControls, PerspectiveCamera, Stats, TransformControls, useCursor } from '@react-three/drei'
import { Leva, useControls } from 'leva'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Backdrop, Box, LinearProgress, Typography } from '@mui/material'
import * as THREE from 'three'
import { useEditorStore } from '../stores/editor'
import { isGeometry } from '../utils/scene'
import {
  resolvePrefab,
  resolveScene,
  resolvedWorldMatrix,
  type ResolvedNode,
  type ResolveResult,
} from '../utils/prefabs'
import { planRenderChunks } from '../utils/renderBatches'
import Geometry from './Geometry'
import { RenderErrorBoundary, type CameraPose } from './RenderGuard'

interface Registry {
  current: Map<string, THREE.Object3D>
}

const BATCH_THRESHOLD = 150
const BATCH_SIZE = 80

function GeometryMesh({ node }: { node: ResolvedNode }) {
  const select = useEditorStore((state) => state.select)
  const [hovered, setHovered] = useState(false)
  useCursor(hovered)

  function handlePointer(event: ThreeEvent<MouseEvent>) {
    event.stopPropagation()
    select(node.key, event.nativeEvent.shiftKey)
  }

  return (
    <mesh
      castShadow={node.castShadow}
      receiveShadow={node.receiveShadow}
      onClick={handlePointer}
      onPointerOver={(event) => { event.stopPropagation(); setHovered(true) }}
      onPointerOut={() => setHovered(false)}
    >
      <Geometry type={node.type} />
      <meshStandardMaterial
        color={node.material.color}
        roughness={node.material.roughness}
        metalness={node.material.metalness}
        transparent={node.material.opacity < 1}
        opacity={node.material.opacity}
        wireframe={node.material.wireframe}
        emissive={hovered ? '#1d4ed8' : '#000000'}
        emissiveIntensity={hovered ? 0.08 : 0}
      />
    </mesh>
  )
}

function LightObject({ node }: { node: ResolvedNode }) {
  const select = useEditorStore((state) => state.select)
  const common = { color: node.material.color, intensity: node.intensity ?? 1, castShadow: node.castShadow }
  return (
    <>
      {node.type === 'directionalLight' && <directionalLight {...common} />}
      {node.type === 'pointLight' && <pointLight {...common} distance={node.distance} />}
      {node.type === 'spotLight' && <spotLight {...common} distance={node.distance} angle={0.45} penumbra={0.35} />}
      <mesh
        scale={0.12}
        onClick={(event) => { event.stopPropagation(); select(node.key, event.nativeEvent.shiftKey) }}
      >
        <octahedronGeometry />
        <meshBasicMaterial color={node.material.color} />
      </mesh>
    </>
  )
}

function CameraObject({ node }: { node: ResolvedNode }) {
  const select = useEditorStore((state) => state.select)
  return (
    <>
      <PerspectiveCamera makeDefault={node.activeCamera} fov={node.fov ?? 50} near={0.1} far={1000} />
      <mesh
        scale={0.25}
        onClick={(event) => { event.stopPropagation(); select(node.key, event.nativeEvent.shiftKey) }}
      >
        <boxGeometry args={[0.8, 0.55, 0.7]} />
        <meshBasicMaterial color="#0ea5e9" wireframe />
      </mesh>
    </>
  )
}

/** 递归渲染解析后的节点树 */
function NodeView({ node, visibleKeys, nodes, registry, rootKeyByHandle }: {
  node: ResolvedNode
  visibleKeys: Set<string>
  nodes: Map<string, ResolvedNode>
  registry: Registry
  /** 实例句柄 id -> 根部件键，用于让层级里选句柄时变换工具能挂上根 group */
  rootKeyByHandle: Map<string, string>
}) {
  const children = useMemo(
    () => [...nodes.values()].filter((item) => item.parentKey === node.key),
    [nodes, node.key],
  )
  const groupRef = useRef<THREE.Group>(null!)

  useEffect(() => {
    const object = groupRef.current
    if (!object) return
    const keys = [node.key]
    // 若本节点是某个实例句柄的根，额外用句柄 id 注册别名
    for (const [handleId, rootKey] of rootKeyByHandle) {
      if (rootKey === node.key) keys.push(handleId)
    }
    keys.forEach((key) => registry.current.set(key, object))
    return () => keys.forEach((key) => registry.current.delete(key))
  }, [node.key, rootKeyByHandle, registry])

  if (!node.visible) return null
  return (
    <group ref={groupRef} position={node.position} rotation={node.rotation} scale={node.scale}>
      {isGeometry(node.type) && <GeometryMesh node={node} />}
      {node.type === 'camera' && <CameraObject node={node} />}
      {(node.type === 'directionalLight' || node.type === 'pointLight' || node.type === 'spotLight') && (
        <LightObject node={node} />
      )}
      {children
        .filter((child) => visibleKeys.has(child.key))
        .map((child) => (
          <NodeView key={child.key} node={child} visibleKeys={visibleKeys} nodes={nodes} registry={registry} rootKeyByHandle={rootKeyByHandle} />
        ))}
    </group>
  )
}

/** 实例模式：非几何节点（灯光/相机）直接按世界矩阵摆放，绕开未渲染的 group 父级 */
function FlatLight({ node, resolved }: { node: ResolvedNode; resolved: ResolveResult }) {
  const matrix = resolvedWorldMatrix(node.key, resolved.nodes)
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  matrix.decompose(position, quaternion, scale)
  const common = { color: node.material.color, intensity: node.intensity ?? 1, castShadow: node.castShadow }
  return (
    <group position={position} quaternion={quaternion} scale={scale}>
      {node.type === 'directionalLight' && <directionalLight {...common} />}
      {node.type === 'pointLight' && <pointLight {...common} distance={node.distance} />}
      {node.type === 'spotLight' && <spotLight {...common} distance={node.distance} angle={0.45} penumbra={0.35} />}
      {node.type === 'camera' && <PerspectiveCamera makeDefault={node.activeCamera} fov={node.fov ?? 50} near={0.1} far={1000} />}
    </group>
  )
}

function SelectionControls({ registry }: { registry: Registry }) {
  const selectedKey = useEditorStore((state) => state.selectedKey)
  const mode = useEditorStore((state) => state.transformMode)
  const snapEnabled = useEditorStore((state) => state.snapEnabled)
  const snapSize = useEditorStore((state) => state.snapSize)
  const setTransform = useEditorStore((state) => state.setTransform)
  const [, refresh] = useState(0)

  useEffect(() => {
    const timer = window.setTimeout(() => refresh((value) => value + 1), 0)
    return () => window.clearTimeout(timer)
  }, [selectedKey])

  const object = selectedKey ? registry.current.get(selectedKey) : undefined
  if (!object || !selectedKey) return null
  const activeKey = selectedKey

  function commit() {
    if (!object) return
    setTransform(activeKey, {
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

function InstanceBatch({ type, batch, resolved }: {
  type: ResolvedNode['type']
  batch: ResolvedNode[]
  resolved: ResolveResult
}) {
  const select = useEditorStore((state) => state.select)
  const ref = useRef<THREE.InstancedMesh>(null!)
  const matrices = useMemo(() => {
    const cache = new Map<string, THREE.Matrix4>()
    return batch.map((node) => resolvedWorldMatrix(node.key, resolved.nodes, cache))
  }, [batch, resolved])

  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    matrices.forEach((matrix, index) => {
      mesh.setMatrixAt(index, matrix)
      mesh.setColorAt(index, new THREE.Color(batch[index].material.color))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [matrices, batch])

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, batch.length]}
      castShadow
      receiveShadow
      frustumCulled={false}
      onClick={(event) => {
        event.stopPropagation()
        const index = event.instanceId
        if (index !== undefined) select(batch[index].key, event.nativeEvent.shiftKey)
      }}
    >
      <Geometry type={type} />
      <meshStandardMaterial vertexColors roughness={0.48} metalness={0.04} />
    </instancedMesh>
  )
}

function InstancedScene({ resolved, registry }: { resolved: ResolveResult; registry: Registry }) {
  const batches = useMemo(() => {
    const map = new Map<ResolvedNode['type'], ResolvedNode[]>()
    ;[...resolved.nodes.values()]
      .filter((node) => isGeometry(node.type) && node.visible)
      .forEach((node) => map.set(node.type, [...(map.get(node.type) ?? []), node]))
    return [...map.entries()]
  }, [resolved])

  const flatNodes = useMemo(
    () => [...resolved.nodes.values()].filter(
      (node) => node.visible && (node.type.includes('Light') || node.type === 'camera'),
    ),
    [resolved],
  )

  return (
    <>
      {batches.map(([type, batch]) => (
        <InstanceBatch key={type} type={type} batch={batch} resolved={resolved} />
      ))}
      {flatNodes.map((node) => <FlatLight key={node.key} node={node} resolved={resolved} />)}
      {/* 让选择控件能拿到实例句柄对应的组（多根容器）用于实例整体变换 */}
      <HandleGroups resolved={resolved} registry={registry} />
    </>
  )
}

/** 为每个实例句柄暴露一个表示其整体摆放的 Object3D 到 registry */
function HandleGroups({ resolved, registry }: { resolved: ResolveResult; registry: Registry }) {
  const objects = useEditorStore((state) => state.objects)
  return (
    <>
      {objects
        .filter((object) => object.instanceOf)
        .map((handle) => {
          const rootKeys = resolved.instanceRootKeys.get(handle.id) ?? []
          const primaryKey = rootKeys[0]
          if (!primaryKey) return null
          return <HandleProxy key={handle.id} nodeKey={primaryKey} handleId={handle.id} resolved={resolved} registry={registry} />
        })}
    </>
  )
}

function HandleProxy({ nodeKey, handleId, resolved, registry }: {
  nodeKey: string
  handleId: string
  resolved: ResolveResult
  registry: Registry
}) {
  const groupRef = useRef<THREE.Group>(null!)
  const node = resolved.nodes.get(nodeKey)
  useEffect(() => {
    if (groupRef.current) registry.current.set(handleId, groupRef.current)
    return () => { registry.current.delete(handleId) }
  }, [handleId, registry])
  if (!node) return null
  return <group ref={groupRef} position={node.position} rotation={node.rotation} scale={node.scale} visible={false} />
}

/** 持续上报相机机位；失败回滚后按快照把相机恢复到渲染前位置 */
function CameraHealth({ poseRef, restoreRef }: { poseRef: React.MutableRefObject<CameraPose>; restoreRef: React.MutableRefObject<CameraPose | null> }) {
  const camera = useThree((state) => state.camera)
  const controls = useThree((state) => state.controls) as (THREE.EventDispatcher & { target: THREE.Vector3 }) | null

  useEffect(() => {
    const pose = restoreRef.current
    if (pose) {
      camera.position.set(...pose.position)
      if (controls) controls.target.set(...pose.target)
      restoreRef.current = null
    }
  }, [camera, controls, restoreRef])

  useEffect(() => {
    let frame = 0
    let raf = 0
    const tick = () => {
      frame += 1
      if (frame % 12 === 0) {
        poseRef.current = {
          position: camera.position.toArray() as [number, number, number],
          target: controls
            ? (controls.target.toArray() as [number, number, number])
            : [0, 0, 0],
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [camera, controls, poseRef])

  return null
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

interface SceneCanvasProps {
  registry: Registry
  poseRef: React.MutableRefObject<CameraPose>
  restoreRef: React.MutableRefObject<CameraPose | null>
  onHealthy: () => void
  onRenderError: () => void
  resetKey: string
}

function SceneCanvas({ registry, poseRef, restoreRef, onHealthy, onRenderError, resetKey }: SceneCanvasProps) {
  const objects = useEditorStore((state) => state.objects)
  const prefabs = useEditorStore((state) => state.prefabs)
  const editingPrefabId = useEditorStore((state) => state.editingPrefabId)
  const performance = useEditorStore((state) => state.performance)

  const resolved = useMemo<ResolveResult>(() => {
    if (editingPrefabId) {
      const asset = prefabs.find((item) => item.id === editingPrefabId)
      return asset ? resolvePrefab(asset, prefabs) : { nodes: new Map(), roots: [], instanceRootKeys: new Map(), issues: [] }
    }
    return resolveScene(objects, prefabs)
  }, [objects, prefabs, editingPrefabId])

  // 分批计划：仅独立对象渲染模式分批；实例模式交给 InstancedMesh
  const chunks = useMemo(
    () => (performance.instanceMode ? [[...resolved.nodes.values()]] : planRenderChunks([...resolved.nodes.values()], {
      chunkSize: BATCH_SIZE,
      threshold: BATCH_THRESHOLD,
    })),
    [resolved, performance.instanceMode],
  )
  const batched = chunks.length > 1
  const [revealedChunks, setRevealedChunks] = useState(batched ? 0 : chunks.length)
  const setRenderState = useEditorStore((state) => state.setRenderState)
  const noticeMessage = useEditorStore((state) => state.noticeMessage)
  const healthyTimer = useRef<number | null>(null)

  // 解析结果变化时重走分批流程
  useEffect(() => {
    if (!batched) {
      setRevealedChunks(chunks.length)
      return
    }
    setRevealedChunks(0)
    setRenderState({ phase: 'batching', done: 0, total: chunks.reduce((sum, chunk) => sum + chunk.length, 0) })
    let index = 0
    let cancelled = false
    const revealNext = () => {
      if (cancelled) return
      index += 1
      setRevealedChunks(index)
      setRenderState({ phase: 'batching', done: chunks.slice(0, index).reduce((sum, chunk) => sum + chunk.length, 0), total: chunks.reduce((sum, chunk) => sum + chunk.length, 0) })
      if (index < chunks.length) {
        // 让出主线程，下一帧再挂下一批
        requestAnimationFrame(() => window.setTimeout(revealNext, 0))
      }
    }
    requestAnimationFrame(() => window.setTimeout(revealNext, 0))
    return () => { cancelled = true }
  }, [chunks, batched, setRenderState])

  // 全部挂完且完成一次绘制后，记录为健康现场
  useEffect(() => {
    if (revealedChunks < chunks.length) return
    if (healthyTimer.current) window.clearTimeout(healthyTimer.current)
    healthyTimer.current = window.setTimeout(() => {
      setRenderState({ phase: 'idle' })
      onHealthy()
    }, batched ? 120 : 60)
    return () => { if (healthyTimer.current) window.clearTimeout(healthyTimer.current) }
  }, [revealedChunks, chunks.length, batched, setRenderState, onHealthy])

  // 解析问题（成环/缺失）上报到状态栏
  const lastIssueRef = useRef('')
  useEffect(() => {
    if (resolved.issues.length === 0) return
    const signature = resolved.issues.map((issue) => `${issue.kind}:${issue.prefabId}`).join('|')
    if (signature !== lastIssueRef.current) {
      lastIssueRef.current = signature
      noticeMessage(resolved.issues[0].message)
    }
  }, [resolved.issues, noticeMessage])

  const visibleKeys = useMemo(() => {
    const set = new Set<string>()
    chunks.slice(0, revealedChunks).flat().forEach((node) => set.add(node.key))
    return set
  }, [chunks, revealedChunks])

  // 单根实例：句柄 id -> 根部件键（多根实例根是合成 group，键即含句柄 id，无需别名）
  const rootKeyByHandle = useMemo(() => {
    const map = new Map<string, string>()
    resolved.instanceRootKeys.forEach((rootKeys, handleId) => {
      if (rootKeys.length === 1) map.set(handleId, rootKeys[0])
    })
    return map
  }, [resolved])

  return (
    <RenderErrorBoundary resetKey={resetKey} onError={onRenderError}>
      <Canvas
        camera={{ position: [6, 5, 8], fov: 48 }}
        shadows={performance.shadows}
        dpr={performance.instanceMode ? [0.7, 1] : [1, performance.pixelRatio]}
        gl={{ antialias: !performance.instanceMode, powerPreference: 'high-performance' }}
      >
        <CameraHealth poseRef={poseRef} restoreRef={restoreRef} />
        <color attach="background" args={['#cdd7e5']} />
        <fog attach="fog" args={['#cdd7e5', 18, 55]} />
        <ambientLight intensity={0.7} />
        {performance.showGrid && <Grid infiniteGrid cellSize={0.5} sectionSize={2.5} fadeDistance={32} sectionColor="#7b8da5" cellColor="#b5c0cf" />}
        {performance.instanceMode ? (
          <InstancedScene resolved={resolved} registry={registry} />
        ) : (
          resolved.roots
            .filter((node) => visibleKeys.has(node.key))
            .map((node) => (
              <NodeView
                key={node.key}
                node={node}
                visibleKeys={visibleKeys}
                nodes={resolved.nodes}
                registry={registry}
                rootKeyByHandle={rootKeyByHandle}
              />
            ))
        )}
        {!performance.instanceMode && <SelectionControls registry={registry} />}
        <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={2} maxDistance={45} />
        <RenderControls />
      </Canvas>
    </RenderErrorBoundary>
  )
}

export default function SceneViewport() {
  const registry = useRef<Map<string, THREE.Object3D>>(new Map())
  const performance = useEditorStore((state) => state.performance)
  const render = useEditorStore((state) => state.render)
  const takeSnapshot = useEditorStore((state) => state.takeSnapshot)
  const restoreSnapshot = useEditorStore((state) => state.restoreSnapshot)
  const lastSnapshot = useEditorStore((state) => state.lastSnapshot)
  const poseRef = useRef<CameraPose>({ position: [6, 5, 8], target: [0, 0, 0] })
  const restoreRef = useRef<CameraPose | null>(null)
  const [resetKey, setResetKey] = useState('initial')
  const recoveringRef = useRef(false)

  const handleHealthy = useCallback(() => {
    takeSnapshot(poseRef.current.position, poseRef.current.target)
    recoveringRef.current = false
  }, [takeSnapshot])

  const handleRenderError = useCallback(() => {
    if (recoveringRef.current) return
    recoveringRef.current = true
    const snapshot = useEditorStore.getState().lastSnapshot
    if (snapshot) {
      restoreRef.current = { position: snapshot.cameraPosition, target: snapshot.cameraTarget }
      restoreSnapshot(snapshot)
    }
    // 换 key 强制错误边界重挂 Canvas，进入恢复现场后的新一轮渲染
    setResetKey(`recover-${Date.now()}`)
  }, [restoreSnapshot, lastSnapshot])

  return (
    <div className="viewport-wrap">
      <SceneCanvas
        key={resetKey}
        registry={registry}
        poseRef={poseRef}
        restoreRef={restoreRef}
        onHealthy={handleHealthy}
        onRenderError={handleRenderError}
        resetKey={resetKey}
      />
      <Leva collapsed titleBar={{ title: '视图控制' }} />
      {render.phase === 'batching' && (
        <Box sx={{ position: 'absolute', left: '50%', bottom: 28, transform: 'translateX(-50%)', width: 280, bgcolor: 'rgba(255,255,255,0.94)', borderRadius: 2, p: 1.4, boxShadow: 3 }}>
          <Typography variant="caption">引用数量较多，正在分批渲染 {render.done}/{render.total}</Typography>
          <LinearProgress variant="determinate" value={render.total ? (render.done / render.total) * 100 : 0} sx={{ mt: 0.6 }} />
        </Box>
      )}
      {render.phase === 'recovering' && (
        <Backdrop open sx={{ position: 'absolute', zIndex: 5, bgcolor: 'rgba(205,215,229,0.7)' }}>
          <Box sx={{ bgcolor: 'background.paper', borderRadius: 2, p: 2, textAlign: 'center' }}>
            <Typography variant="subtitle2">渲染失败，正在恢复现场…</Typography>
            <Typography variant="caption" color="text.secondary">已回滚到上一次成功渲染的状态与机位</Typography>
          </Box>
        </Backdrop>
      )}
    </div>
  )
}
