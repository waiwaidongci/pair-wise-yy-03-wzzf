import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import * as THREE from 'three'
import type {
  MaterialSpec,
  ObjectType,
  OverridePatch,
  PerformanceSettings,
  PrefabAsset,
  RenderState,
  SceneDocument,
  SceneObject,
  SceneSnapshot,
  TransformMode,
  Vec3,
} from '../types/scene'
import { createInstanceHandle, createSceneObject, createStarterScene, descendantsOf, uid } from '../utils/scene'
import {
  applyOverride,
  decomposeMatrix,
  isInstanceHandle,
  parseInstanceKey,
  resolveScene,
  resolvedWorldMatrix,
  wouldCreateCycle,
} from '../utils/prefabs'
import { migrateDocument } from '../utils/migration'

/** 选择目标：普通对象/实例句柄用对象 id；实例内部件用 instance: 键 */
export type SelectionKey = string

/**
 * 节点更新补丁。材质按属性粒度传：只给改了的字段，
 * 未给的材质属性继续跟随组合件源，不会被覆盖误伤。
 */
export type NodeUpdatePatch = Omit<Partial<SceneObject>, 'material'> & {
  material?: Partial<MaterialSpec>
}

interface EditorState {
  name: string
  objects: SceneObject[]
  prefabs: PrefabAsset[]
  selectedKey: SelectionKey | null
  /** 多选（用于"把选中的一组对象做成组合件"） */
  selectedKeys: SelectionKey[]
  transformMode: TransformMode
  snapEnabled: boolean
  snapSize: number
  performance: PerformanceSettings
  render: RenderState
  /** 非 null 时正在编辑该组合件源，层级/视口/检查器都切到模板 */
  editingPrefabId: string | null
  notice: string
  /** 上一次成功渲染的现场（渲染失败时回滚用），放在 store 外 */
  lastSnapshot: SceneSnapshot | null

  select: (key: SelectionKey | null, additive?: boolean) => void
  add: (type: ObjectType, parentKey?: SelectionKey | null) => void
  updateNode: (key: SelectionKey, patch: NodeUpdatePatch) => void
  setTransform: (key: SelectionKey, patch: Pick<SceneObject, 'position' | 'rotation' | 'scale'>) => void
  reparent: (id: string, parentId: string | null) => boolean
  remove: (key: SelectionKey) => void
  duplicate: (key: SelectionKey) => void
  setTransformMode: (mode: TransformMode) => void
  setSnapEnabled: (enabled: boolean) => void
  setSnapSize: (size: number) => void
  setPerformance: (patch: Partial<PerformanceSettings>) => void
  align: (axis: 0 | 1 | 2) => void
  addStressObjects: (count?: number) => void
  addPrefabInstance: (prefabId: string, position?: Vec3) => void
  createPrefabFromSelection: () => boolean
  enterPrefab: (prefabId: string) => void
  exitPrefab: () => void
  resetOverride: (instanceId: string, nodePath: string, field: keyof OverridePatch | `material.${keyof MaterialSpec}`) => void
  resetAllOverrides: (instanceId: string) => void
  loadScene: (document: unknown) => void
  reset: () => void
  noticeMessage: (message: string) => void
  setRenderState: (patch: Partial<RenderState>) => void
  takeSnapshot: (cameraPosition: Vec3, cameraTarget: Vec3) => SceneSnapshot
  restoreSnapshot: (snapshot: SceneSnapshot) => void
}

const starter = createStarterScene()

/** 找到一个实例句柄上指定模板路径的覆盖条目（没有则创建） */
function ensureOverride(handle: SceneObject, nodePath: string) {
  if (!handle.overrides) handle.overrides = []
  let entry = handle.overrides.find((item) => item.nodePath === nodePath)
  if (!entry) {
    entry = { nodePath, patch: {} }
    handle.overrides.push(entry)
  }
  return entry
}

/** 把更新补丁应用到节点；材质按属性合并，允许只给部分材质字段 */
function applyNodePatch(node: SceneObject, patch: NodeUpdatePatch) {
  const { material, ...rest } = patch
  Object.assign(node, rest)
  if (material) node.material = { ...node.material, ...material }
}

/** 从被选的一组对象里挑出真正的根（排除掉祖先也被选中的对象） */
function topLevelSelected(ids: string[], objects: SceneObject[]): SceneObject[] {
  const selected = new Set(ids)
  return objects.filter((object) => {
    if (!selected.has(object.id)) return false
    let parentId = object.parentId
    while (parentId) {
      if (selected.has(parentId)) return false
      parentId = objects.find((item) => item.id === parentId)?.parentId ?? null
    }
    return true
  })
}

export const useEditorStore = create<EditorState>()(
  immer((set, get) => ({
    name: '产品发布会三维展台',
    objects: starter.objects,
    prefabs: starter.prefabs,
    selectedKey: 'showcase-a',
    selectedKeys: ['showcase-a'],
    transformMode: 'translate',
    snapEnabled: true,
    snapSize: 0.25,
    performance: { instanceMode: false, shadows: true, showGrid: true, pixelRatio: 1.5 },
    render: { phase: 'idle', done: 0, total: 0 },
    editingPrefabId: null,
    notice: '选择物体后可使用 G / R / S 切换变换工具',
    lastSnapshot: null,

    select: (key, additive = false) =>
      set((state) => {
        state.selectedKey = key
        if (!key) {
          state.selectedKeys = []
        } else if (additive) {
          state.selectedKeys = state.selectedKeys.includes(key)
            ? state.selectedKeys.filter((item) => item !== key)
            : [...state.selectedKeys, key]
          if (state.selectedKeys.length === 0) state.selectedKey = null
        } else {
          state.selectedKeys = [key]
        }
      }),

    add: (type, parentKey = null) =>
      set((state) => {
        // 编辑组合件源：新对象加进模板
        if (state.editingPrefabId) {
          const asset = state.prefabs.find((item) => item.id === state.editingPrefabId)
          if (!asset) return
          const node = createSceneObject(type)
          node.parentId = parentKey && !parentKey.startsWith('instance:') ? parentKey : null
          asset.nodes.push(node)
          state.selectedKey = node.id
          state.selectedKeys = [node.id]
          state.notice = `已在组合件「${asset.name}」中添加${node.name}`
          return
        }

        const object = createSceneObject(type, parentKey)
        const siblings = state.objects.filter((item) => item.parentId === parentKey).length
        object.position[0] += siblings * 0.8
        state.objects.push(object)
        state.selectedKey = object.id
        state.selectedKeys = [object.id]
        state.notice = `已添加${object.name}`
      }),

    updateNode: (key, patch) =>
      set((state) => {
        const parsed = parseInstanceKey(key)
        if (state.editingPrefabId) {
          const asset = state.prefabs.find((item) => item.id === state.editingPrefabId)
          const node = asset?.nodes.find((item) => item.id === key)
          if (node) applyNodePatch(node, patch)
          return
        }
        if (parsed) {
          // 实例内部件：写覆盖，源值保持不变
          const handle = state.objects.find((item) => item.id === parsed.instanceId)
          if (!handle) return
          const entry = ensureOverride(handle, parsed.nodePath)
          const { position, rotation, scale, visible, castShadow, receiveShadow, material, intensity, distance, fov, activeCamera } = patch
          if (position) entry.patch.position = [...position] as Vec3
          if (rotation) entry.patch.rotation = [...rotation] as Vec3
          if (scale) entry.patch.scale = [...scale] as Vec3
          if (visible !== undefined) entry.patch.visible = visible
          if (castShadow !== undefined) entry.patch.castShadow = castShadow
          if (receiveShadow !== undefined) entry.patch.receiveShadow = receiveShadow
          if (intensity !== undefined) entry.patch.intensity = intensity
          if (distance !== undefined) entry.patch.distance = distance
          if (fov !== undefined) entry.patch.fov = fov
          if (activeCamera !== undefined) entry.patch.activeCamera = activeCamera
          if (material) entry.patch.material = { ...(entry.patch.material ?? {}), ...material }
          return
        }
        const object = state.objects.find((item) => item.id === key)
        if (object) applyNodePatch(object, patch)
      }),

    setTransform: (key, patch) =>
      set((state) => {
        const parsed = parseInstanceKey(key)
        if (state.editingPrefabId) {
          const asset = state.prefabs.find((item) => item.id === state.editingPrefabId)
          const node = asset?.nodes.find((item) => item.id === key)
          if (node) {
            node.position = patch.position
            node.rotation = patch.rotation
            node.scale = patch.scale
          }
          return
        }
        if (parsed) {
          const handle = state.objects.find((item) => item.id === parsed.instanceId)
          if (!handle) return
          const entry = ensureOverride(handle, parsed.nodePath)
          entry.patch.position = [...patch.position] as Vec3
          entry.patch.rotation = [...patch.rotation] as Vec3
          entry.patch.scale = [...patch.scale] as Vec3
          return
        }
        const object = state.objects.find((item) => item.id === key)
        if (object) {
          object.position = patch.position
          object.rotation = patch.rotation
          object.scale = patch.scale
        }
      }),

    reparent: (id, parentId) => {
      if (id === parentId) return false
      const state = get()
      if (parentId && descendantsOf(id, state.editingPrefabId
        ? state.prefabs.find((item) => item.id === state.editingPrefabId)?.nodes ?? []
        : state.objects).has(parentId)) {
        get().noticeMessage('无法将物体挂载到自身的子级')
        return false
      }
      set((draft) => {
        const list = draft.editingPrefabId
          ? draft.prefabs.find((item) => item.id === draft.editingPrefabId)?.nodes
          : draft.objects
        const object = list?.find((item) => item.id === id)
        if (object) object.parentId = parentId
      })
      return true
    },

    remove: (key) =>
      set((state) => {
        const parsed = parseInstanceKey(key)
        if (state.editingPrefabId) {
          const asset = state.prefabs.find((item) => item.id === state.editingPrefabId)
          if (!asset) return
          const removed = descendantsOf(key, asset.nodes)
          removed.add(key)
          asset.nodes = asset.nodes.filter((item) => !removed.has(item.id))
          if (state.selectedKey === key) {
            state.selectedKey = null
            state.selectedKeys = []
          }
          return
        }
        if (parsed) {
          state.notice = '实例内部件不能单独删除，请编辑组合件源'
          return
        }
        const removed = descendantsOf(key, state.objects)
        removed.add(key)
        state.objects = state.objects.filter((item) => !removed.has(item.id))
        if (state.selectedKey && removed.has(state.selectedKey)) {
          state.selectedKey = null
          state.selectedKeys = []
        }
        state.notice = `已删除 ${removed.size} 个对象`
      }),

    duplicate: (key) =>
      set((state) => {
        if (state.editingPrefabId) return
        const parsed = parseInstanceKey(key)
        if (parsed) {
          // 复制整个引用实例（不复制部件）
          const source = state.objects.find((item) => item.id === parsed.instanceId)
          if (!source) return
          const copy: SceneObject = JSON.parse(JSON.stringify(source)) as SceneObject
          copy.id = uid('instance')
          copy.name = `${source.name} 副本`
          copy.position = [source.position[0] + 0.8, source.position[1], source.position[2]]
          state.objects.push(copy)
          state.selectedKey = copy.id
          state.selectedKeys = [copy.id]
          state.notice = '已复制组合件实例'
          return
        }
        const source = state.objects.find((item) => item.id === key)
        if (!source) return
        const subtree = descendantsOf(key, state.objects)
        subtree.add(key)
        const clones = state.objects
          .filter((item) => subtree.has(item.id))
          .map((item) => JSON.parse(JSON.stringify(item)) as SceneObject)
        const idMap = new Map<string, string>()
        clones.forEach((item) => idMap.set(item.id, uid(item.type)))
        clones.forEach((item) => {
          item.id = idMap.get(item.id) as string
          item.parentId = item.parentId && idMap.has(item.parentId) ? idMap.get(item.parentId)! : source.parentId
          if (item.id === idMap.get(key)) {
            item.name = `${source.name} 副本`
            item.position = [source.position[0] + 0.8, source.position[1], source.position[2]]
          }
          state.objects.push(item)
        })
        const newRootId = idMap.get(key) as string
        state.selectedKey = newRootId
        state.selectedKeys = [newRootId]
        state.notice = '已复制物体'
      }),

    setTransformMode: (mode) => set((state) => { state.transformMode = mode }),
    setSnapEnabled: (enabled) => set((state) => { state.snapEnabled = enabled }),
    setSnapSize: (size) => set((state) => { state.snapSize = size }),
    setPerformance: (patch) => set((state) => { Object.assign(state.performance, patch) }),

    align: (axis) =>
      set((state) => {
        const key = state.selectedKey
        if (!key) return
        const parsed = parseInstanceKey(key)
        if (parsed) {
          const handle = state.objects.find((item) => item.id === parsed.instanceId)
          if (!handle) return
          const entry = ensureOverride(handle, parsed.nodePath)
          entry.patch.position = entry.patch.position
            ? ([...entry.patch.position] as Vec3)
            : ([0, 0, 0] as Vec3)
          entry.patch.position[axis] = 0
        } else if (state.editingPrefabId) {
          const node = state.prefabs.find((item) => item.id === state.editingPrefabId)?.nodes.find((item) => item.id === key)
          if (node) node.position[axis] = 0
        } else {
          const object = state.objects.find((item) => item.id === key)
          if (object) object.position[axis] = 0
        }
        state.notice = `已沿 ${['X', 'Y', 'Z'][axis]} 轴对齐到原点`
      }),

    addStressObjects: (count = 240) =>
      set((state) => {
        for (let index = 0; index < count; index += 1) {
          const type: ObjectType = index % 3 === 0 ? 'box' : index % 3 === 1 ? 'sphere' : 'cylinder'
          const object = createSceneObject(type)
          const grid = 20
          object.name = `压力测试 ${index + 1}`
          object.position = [
            ((index % grid) - grid / 2) * 0.75,
            0.35 + Math.floor(index / (grid * grid)) * 0.7,
            (Math.floor(index / grid) % grid - grid / 2) * 0.75,
          ]
          object.scale = [0.25, 0.25, 0.25]
          object.material.color = ['#3b82f6', '#14b8a6', '#f59e0b', '#ef4444'][index % 4]
          state.objects.push(object)
        }
        state.performance.instanceMode = true
        state.notice = `已添加 ${count} 个几何体并开启实例化渲染`
      }),

    addPrefabInstance: (prefabId, position) =>
      set((state) => {
        const asset = state.prefabs.find((item) => item.id === prefabId)
        if (!asset) return

        // 成环防护：往组合件源里放引用时先验图
        if (state.editingPrefabId) {
          if (wouldCreateCycle(state.prefabs, state.editingPrefabId, prefabId)) {
            state.notice = `不能在「${asset.name}」中引用它自身或其下游组合件，会形成嵌套环`
            return
          }
          const handle = createInstanceHandle(asset, asset.name, position ?? [0, 0.8, 0])
          const target = state.prefabs.find((item) => item.id === state.editingPrefabId)
          target?.nodes.push(handle)
          state.selectedKey = handle.id
          state.selectedKeys = [handle.id]
          state.notice = `已在组合件源中嵌套「${asset.name}」`
          return
        }

        const handle = createInstanceHandle(asset, asset.name, position ?? [0, 0, 0])
        const count = state.objects.filter((item) => item.instanceOf === prefabId).length
        handle.name = `${asset.name} ${count + 1}`
        if (!position) {
          const jitter = count % 24
          handle.position = [((jitter % 8) - 3.5) * 1.8, 0, (Math.floor(jitter / 8) - 1) * 1.8 + Math.floor(count / 24) * 3]
        }
        state.objects.push(handle)
        state.selectedKey = handle.id
        state.selectedKeys = [handle.id]
        state.notice = `已放置「${asset.name}」引用实例`
      }),

    createPrefabFromSelection: () => {
      const state = get()
      if (state.editingPrefabId) {
        get().noticeMessage('请先退出组合件源编辑')
        return false
      }
      const plainIds = state.selectedKeys.filter((key) => !parseInstanceKey(key))
      const roots = topLevelSelected(plainIds, state.objects)
      if (roots.length === 0) {
        get().noticeMessage('请先在场景里选择一个或多个对象')
        return false
      }

      // 解析当前场景（实例展平）后计算世界矩阵，用于烘焙成独立模板
      const resolved = resolveScene(state.objects, state.prefabs)
      const anchorMatrix = resolvedWorldMatrix(roots[0].id, resolved.nodes)
      const anchorInverse = anchorMatrix.clone().invert()
      const anchor = decomposeMatrix(anchorMatrix)

      const removedIds = new Set<string>()
      roots.forEach((root) => {
        removedIds.add(root.id)
        descendantsOf(root.id, state.objects).forEach((id) => removedIds.add(id))
      })

      // 从解析结果烘焙模板节点（实例内部件被展平成普通节点，世界坐标转成相对锚点的局部坐标）
      const templateNodes: SceneObject[] = []
      roots.forEach((root) => {
        const instanceRootKeys = resolved.instanceRootKeys.get(root.id)
        if (instanceRootKeys) {
          // 选中的是实例句柄：烘焙其展开后的根（保留覆盖后的值）
          instanceRootKeys.forEach((rootKey) =>
            bakeResolvedSubtree(rootKey, resolved.nodes, templateNodes, anchorInverse, null),
          )
        } else {
          bakeResolvedSubtree(root.id, resolved.nodes, templateNodes, anchorInverse, null)
        }
      })

      if (templateNodes.length === 0) {
        get().noticeMessage('所选对象无法组成组合件')
        return false
      }

      const prefabId = uid('prefab')
      const asset: PrefabAsset = {
        id: prefabId,
        name: `组合件 ${state.prefabs.length + 1}`,
        nodes: templateNodes,
        createdAt: new Date().toISOString(),
      }

      const handle = createInstanceHandle(asset, asset.name, anchor.position)
      handle.rotation = anchor.rotation
      handle.scale = anchor.scale

      set((draft) => {
        draft.prefabs.push(asset)
        draft.objects = draft.objects.filter((item) => !removedIds.has(item.id))
        draft.objects.push(handle)
        draft.selectedKey = handle.id
        draft.selectedKeys = [handle.id]
        draft.notice = `已生成组合件「${asset.name}」并替换为引用实例`
      })
      return true
    },

    enterPrefab: (prefabId) =>
      set((state) => {
        const asset = state.prefabs.find((item) => item.id === prefabId)
        if (!asset) return
        state.editingPrefabId = prefabId
        const firstRoot = asset.nodes.find((node) => !node.parentId)
        state.selectedKey = firstRoot?.id ?? null
        state.selectedKeys = firstRoot ? [firstRoot.id] : []
        state.notice = `正在编辑组合件源「${asset.name}」，改动会传播到所有未覆盖的实例`
      }),

    exitPrefab: () =>
      set((state) => {
        state.editingPrefabId = null
        state.selectedKey = null
        state.selectedKeys = []
        state.notice = '已返回场景'
      }),

    resetOverride: (instanceId, nodePath, field) =>
      set((state) => {
        const handle = state.objects.find((item) => item.id === instanceId)
        if (!handle?.overrides) return
        const entry = handle.overrides.find((item) => item.nodePath === nodePath)
        if (!entry) return
        if (field.startsWith('material.')) {
          const materialField = field.slice('material.'.length) as keyof MaterialSpec
          if (entry.patch.material) {
            delete entry.patch.material[materialField]
            // material 子对象清空后一并移除，避免残留空对象挡住条目回收
            if (Object.keys(entry.patch.material).length === 0) delete entry.patch.material
          }
        } else {
          delete entry.patch[field as keyof OverridePatch]
        }
        if (Object.keys(entry.patch).length === 0) {
          handle.overrides = handle.overrides.filter((item) => item !== entry)
        }
        state.notice = '该属性已恢复跟随组合件源'
      }),

    resetAllOverrides: (instanceId) =>
      set((state) => {
        const handle = state.objects.find((item) => item.id === instanceId)
        if (!handle) return
        handle.overrides = []
        state.notice = `实例「${handle.name}」已全部恢复跟随源`
      }),

    loadScene: (input) =>
      set((state) => {
        // 旧数据先升级兼容再读入
        const { document, fromVersion } = migrateDocument(input)
        state.name = document.name
        state.objects = document.objects
        state.prefabs = document.prefabs
        state.editingPrefabId = null
        state.selectedKey = document.objects[0]?.id ?? null
        state.selectedKeys = state.selectedKey ? [state.selectedKey] : []
        state.render = { phase: 'idle', done: 0, total: 0 }
        state.notice =
          fromVersion && fromVersion < 2
            ? `已把 v${fromVersion} 旧场景升级为组合件格式（v2）后读入`
            : '场景 JSON 已导入'
      }),

    reset: () =>
      set((state) => {
        const fresh = createStarterScene()
        state.name = '产品发布会三维展台'
        state.objects = fresh.objects
        state.prefabs = fresh.prefabs
        state.selectedKey = 'showcase-a'
        state.selectedKeys = ['showcase-a']
        state.editingPrefabId = null
        state.notice = '已恢复示例场景'
      }),

    noticeMessage: (message) => set((state) => { state.notice = message }),

    setRenderState: (patch) => set((state) => { Object.assign(state.render, patch) }),

    takeSnapshot: (cameraPosition, cameraTarget) => {
      const state = get()
      const snapshot: SceneSnapshot = {
        name: state.name,
        objects: JSON.parse(JSON.stringify(state.objects)) as SceneObject[],
        prefabs: JSON.parse(JSON.stringify(state.prefabs)) as PrefabAsset[],
        selectedKey: state.selectedKey,
        editingPrefabId: state.editingPrefabId,
        cameraPosition: [...cameraPosition] as Vec3,
        cameraTarget: [...cameraTarget] as Vec3,
      }
      set((draft) => { draft.lastSnapshot = snapshot })
      return snapshot
    },

    restoreSnapshot: (snapshot) =>
      set((state) => {
        state.name = snapshot.name
        state.objects = JSON.parse(JSON.stringify(snapshot.objects)) as SceneObject[]
        state.prefabs = JSON.parse(JSON.stringify(snapshot.prefabs)) as PrefabAsset[]
        state.selectedKey = snapshot.selectedKey
        state.selectedKeys = snapshot.selectedKey ? [snapshot.selectedKey] : []
        state.editingPrefabId = snapshot.editingPrefabId
        state.render = { phase: 'recovering', done: 0, total: 0 }
        state.notice = '渲染失败，已恢复到上一次成功渲染的现场'
      }),
  })),
)

/** 把解析子树烘焙成模板节点（局部坐标相对各自父节点，id 全部重发） */
function bakeResolvedSubtree(
  key: string,
  nodes: Map<string, import('../utils/prefabs').ResolvedNode>,
  output: SceneObject[],
  parentWorldInverse: THREE.Matrix4,
  parentNewId: string | null,
) {
  const node = nodes.get(key)
  if (!node) return
  const world = resolvedWorldMatrix(key, nodes)
  const local = new THREE.Matrix4().multiplyMatrices(parentWorldInverse, world)
  const transform = decomposeMatrix(local)
  const newId = uid('pfn')

  const clone: SceneObject = {
    id: newId,
    name: node.name,
    type: node.type,
    parentId: parentNewId,
    visible: node.visible,
    ...transform,
    castShadow: node.castShadow,
    receiveShadow: node.receiveShadow,
    material: { ...node.material },
  }
  if (node.intensity !== undefined) clone.intensity = node.intensity
  if (node.distance !== undefined) clone.distance = node.distance
  if (node.fov !== undefined) clone.fov = node.fov
  if (node.activeCamera !== undefined) clone.activeCamera = node.activeCamera
  output.push(clone)

  const worldInverse = world.clone().invert()
  ;[...nodes.values()]
    .filter((child) => child.parentKey === key)
    .forEach((child) => bakeResolvedSubtree(child.key, nodes, output, worldInverse, newId))
}

export function updateVector(vector: Vec3, axis: 0 | 1 | 2, value: number): Vec3 {
  const next: Vec3 = [...vector]
  next[axis] = value
  return next
}

export { isInstanceHandle, applyOverride }
