import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { ComponentDef, ObjectType, PerformanceSettings, SceneDocument, SceneObject, TransformMode, Vec3 } from '../types/scene'
import { createSceneObject, createStarterScene, descendantsOf, uid } from '../utils/scene'
import {
  buildComponentFromSelection,
  buildTemplateFromObjects,
  cloneSceneObject,
  flattenTemplate,
  instantiateComponent,
  migrateDocument,
  resolveInstance,
  wouldCreateCycle,
} from '../utils/components'

/** 进入组合件编辑模式前的场景快照（取消编辑时恢复） */
let preEditSnapshot: { objects: SceneObject[]; name: string } | null = null

interface EditorState {
  name: string
  objects: SceneObject[]
  components: ComponentDef[]
  editingComponentId: string | null
  selectedId: string | null
  transformMode: TransformMode
  snapEnabled: boolean
  snapSize: number
  performance: PerformanceSettings
  notice: string
  select: (id: string | null) => void
  add: (type: ObjectType, parentId?: string | null) => void
  update: (id: string, patch: Partial<SceneObject>) => void
  setTransform: (id: string, patch: Pick<SceneObject, 'position' | 'rotation' | 'scale'>) => void
  reparent: (id: string, parentId: string | null) => boolean
  remove: (id: string) => void
  duplicate: (id: string) => void
  setTransformMode: (mode: TransformMode) => void
  setSnapEnabled: (enabled: boolean) => void
  setSnapSize: (size: number) => void
  setPerformance: (patch: Partial<PerformanceSettings>) => void
  align: (axis: 0 | 1 | 2) => void
  addStressObjects: (count?: number) => void
  makeComponent: (ids: string[]) => void
  placeInstance: (componentId: string) => void
  breakInstance: (id: string) => void
  resetOverrides: (id: string, kind?: 'position' | 'material') => void
  applyToSource: (id: string) => void
  startEditComponent: (componentId: string) => void
  finishEditComponent: (save: boolean) => void
  removeComponent: (componentId: string) => void
  loadScene: (document: unknown) => void
  reset: () => void
  noticeMessage: (message: string) => void
}

export const useEditorStore = create<EditorState>()(immer((set, get) => ({
  name: '产品发布会三维展台',
  objects: createStarterScene(),
  components: [],
  editingComponentId: null,
  selectedId: 'hero-box',
  transformMode: 'translate',
  snapEnabled: true,
  snapSize: 0.25,
  performance: { instanceMode: false, shadows: true, showGrid: true, pixelRatio: 1.5 },
  notice: '选择物体后可使用 G / R / S 切换变换工具',

  select: (id) => set((state: EditorState) => { state.selectedId = id }),

  add: (type, parentId = null) => set((state: EditorState) => {
    const object = createSceneObject(type, parentId)
    const index = state.objects.filter((item) => item.parentId === parentId).length
    object.position[0] += index * 0.8
    object.position[2] += index * 0.35
    state.objects.push(object)
    state.selectedId = object.id
    state.notice = `已添加${object.name}`
  }),

  update: (id, patch) => set((state: EditorState) => {
    const index = state.objects.findIndex((item) => item.id === id)
    if (index < 0) return
    const target = state.objects[index]
    state.objects[index] = { ...target, ...patch }
    // 引用实例被单独调过位置或材质后，打上覆盖标记，源改动盖不掉
    if (target.componentId) {
      const overrides = { ...(target.overrides ?? { position: false, material: false }) }
      if ('position' in patch || 'rotation' in patch || 'scale' in patch) overrides.position = true
      if ('material' in patch) overrides.material = true
      state.objects[index].overrides = overrides
    }
  }),

  setTransform: (id, patch) => set((state: EditorState) => {
    const object = state.objects.find((item) => item.id === id)
    if (!object) return
    object.position = patch.position
    object.rotation = patch.rotation
    object.scale = patch.scale
    if (object.componentId) {
      object.overrides = { ...(object.overrides ?? { position: false, material: false }), position: true }
    }
  }),

  reparent: (id, parentId) => {
    if (id === parentId || (parentId && descendantsOf(id, get().objects).has(parentId))) {
      set((state: EditorState) => { state.notice = '无法将物体挂载到自身的子级' })
      return false
    }
    set((state: EditorState) => {
      const object = state.objects.find((item) => item.id === id)
      if (object) object.parentId = parentId
      state.notice = parentId ? '层级关系已更新' : '已移动到场景根节点'
    })
    return true
  },

  remove: (id) => set((state: EditorState) => {
    const removed = descendantsOf(id, state.objects)
    removed.add(id)
    state.objects = state.objects.filter((item) => !removed.has(item.id))
    if (state.selectedId && removed.has(state.selectedId)) state.selectedId = null
    state.notice = `已删除 ${removed.size} 个对象`
  }),

  duplicate: (id) => set((state: EditorState) => {
    const source = state.objects.find((item) => item.id === id)
    if (!source) return
    const copy = JSON.parse(JSON.stringify(source)) as SceneObject
    copy.id = uid(source.type)
    copy.name = `${source.name} 副本`
    copy.position[0] += 0.8
    state.objects.push(copy)
    state.selectedId = copy.id
    state.notice = '已复制物体'
  }),

  setTransformMode: (mode) => set((state: EditorState) => { state.transformMode = mode }),
  setSnapEnabled: (enabled) => set((state: EditorState) => { state.snapEnabled = enabled }),
  setSnapSize: (size) => set((state: EditorState) => { state.snapSize = size }),
  setPerformance: (patch) => set((state: EditorState) => { Object.assign(state.performance, patch) }),

  align: (axis) => set((state: EditorState) => {
    const object = state.objects.find((item) => item.id === state.selectedId)
    if (!object) return
    object.position[axis] = 0
    state.notice = `已沿 ${['X', 'Y', 'Z'][axis]} 轴对齐到原点`
  }),

  addStressObjects: (count = 240) => set((state: EditorState) => {
    for (let index = 0; index < count; index += 1) {
      const type: ObjectType = index % 3 === 0 ? 'box' : index % 3 === 1 ? 'sphere' : 'cylinder'
      const object = createSceneObject(type)
      const grid = 20
      object.name = `压力测试 ${index + 1}`
      object.position = [((index % grid) - grid / 2) * 0.75, 0.35 + Math.floor(index / (grid * grid)) * 0.7, (Math.floor(index / grid) % grid - grid / 2) * 0.75]
      object.scale = [0.25, 0.25, 0.25]
      object.material.color = ['#3b82f6', '#14b8a6', '#f59e0b', '#ef4444'][index % 4]
      state.objects.push(object)
    }
    state.performance.instanceMode = true
    state.notice = `已添加 ${count} 个几何体并开启实例化渲染`
  }),

  makeComponent: (ids) => set((state: EditorState) => {
    const component = buildComponentFromSelection(ids, state.objects)
    if (!component) {
      state.notice = '请先选择要做成组合件的对象'
      return
    }
    state.components.push(component)
    state.notice = `已把 ${ids.length} 个对象做成组合件「${component.name}」`
  }),

  placeInstance: (componentId) => set((state: EditorState) => {
    const component = state.components.find((item) => item.id === componentId)
    if (!component) return
    // 编辑组合件时放置引用实例，要挡住成环的嵌套
    if (state.editingComponentId && wouldCreateCycle(state.editingComponentId, componentId, state.components)) {
      state.notice = '无法放置：该引用会与当前组合件形成嵌套环'
      return
    }
    const parentId = state.selectedId && state.objects.some((item) => item.id === state.selectedId) ? state.selectedId : null
    const instance = instantiateComponent(component, parentId)
    instance.position[0] += 0.9
    state.objects.push(instance)
    state.selectedId = instance.id
    state.notice = `已放置组合件「${component.name}」的引用实例`
  }),

  breakInstance: (id) => {
    const { objects, components } = get()
    const instance = objects.find((item) => item.id === id)
    if (!instance?.componentId) return
    const resolved = resolveInstance(instance, components)
    const flat: SceneObject[] = []
    const walk = (node: { object: SceneObject; children: any[] }, parentId: string | null, rootId?: string) => {
      const obj = cloneSceneObject(node.object)
      obj.parentId = parentId
      obj.componentId = undefined
      obj.overrides = undefined
      // 展开后的根对象保留实例自身的 id，保证解除引用后选中与身份连续
      if (rootId) obj.id = rootId
      flat.push(obj)
      node.children.forEach((child) => walk(child, obj.id))
    }
    walk(resolved, instance.parentId, id)
    const root = flat[0]
    set((state: EditorState) => {
      state.objects = state.objects.filter((item) => item.id !== id)
      flat.forEach((item) => state.objects.push(item))
      state.selectedId = root.id
      state.notice = '已解除引用，实例展开为独立对象'
    })
  },

  resetOverrides: (id, kind) => set((state: EditorState) => {
    const instance = state.objects.find((item) => item.id === id)
    if (!instance?.componentId) return
    const component = state.components.find((item) => item.id === instance.componentId)
    const overrides = { ...(instance.overrides ?? { position: false, material: false }) }
    if (!kind || kind === 'position') {
      overrides.position = false
      if (component) {
        instance.position = [...component.root.object.position]
        instance.rotation = [...component.root.object.rotation]
        instance.scale = [...component.root.object.scale]
      }
    }
    if (!kind || kind === 'material') {
      overrides.material = false
      if (component) instance.material = JSON.parse(JSON.stringify(component.root.object.material))
    }
    instance.overrides = overrides
    state.notice = kind ? '已重置该项覆盖' : '已重置全部覆盖，实例恢复跟随源组合件'
  }),

  applyToSource: (id) => set((state: EditorState) => {
    const instance = state.objects.find((item) => item.id === id)
    if (!instance?.componentId) return
    const component = state.components.find((item) => item.id === instance.componentId)
    if (!component) return
    const overrides = instance.overrides ?? { position: false, material: false }
    if (overrides.position) {
      component.root.object.position = [...instance.position]
      component.root.object.rotation = [...instance.rotation]
      component.root.object.scale = [...instance.scale]
    }
    if (overrides.material) {
      component.root.object.material = JSON.parse(JSON.stringify(instance.material))
    }
    instance.overrides = { position: false, material: false }
    state.notice = '已把覆盖应用到源组合件，未覆盖的引用已跟随更新'
  }),

  startEditComponent: (componentId) => set((state: EditorState) => {
    const component = state.components.find((item) => item.id === componentId)
    if (!component) return
    preEditSnapshot = { objects: state.objects.map(cloneSceneObject), name: state.name }
    state.objects = flattenTemplate(component.root)
    state.editingComponentId = componentId
    state.selectedId = state.objects[0]?.id ?? null
    state.notice = `正在编辑组合件「${component.name}」，完成后点击「完成编辑」`
  }),

  finishEditComponent: (save) => set((state: EditorState) => {
    const editingId = state.editingComponentId
    if (!editingId) return
    if (save) {
      const root = buildTemplateFromObjects(state.objects)
      state.components = state.components.map((component) =>
        component.id === editingId ? { ...component, root } : component,
      )
    }
    if (preEditSnapshot) {
      state.objects = preEditSnapshot.objects
      state.name = preEditSnapshot.name
    }
    preEditSnapshot = null
    state.editingComponentId = null
    state.selectedId = null
    state.notice = save ? '组合件已更新，未覆盖的引用已跟随重算' : '已取消组合件编辑'
  }),

  removeComponent: (componentId) => set((state: EditorState) => {
    const count = state.objects.filter((item) => item.componentId === componentId).length
    state.components = state.components.filter((item) => item.id !== componentId)
    state.notice = count > 0
      ? `组合件已删除，${count} 个引用实例将显示为占位（可解除引用）`
      : '组合件已删除'
  }),

  loadScene: (document) => {
    const migrated = migrateDocument(document)
    set((state: EditorState) => {
      state.name = migrated.name
      state.objects = migrated.objects
      state.components = migrated.components
      state.editingComponentId = null
      state.selectedId = migrated.objects[0]?.id ?? null
      state.notice = migrated.version < 2 ? '旧场景数据已升级并导入' : '场景 JSON 已导入'
    })
  },

  reset: () => set((state: EditorState) => {
    state.name = '产品发布会三维展台'
    state.objects = createStarterScene()
    state.components = []
    state.editingComponentId = null
    state.selectedId = 'hero-box'
    state.notice = '已恢复示例场景'
  }),

  noticeMessage: (message) => set((state: EditorState) => { state.notice = message }),
})))

export function updateVector(vector: Vec3, axis: 0 | 1 | 2, value: number): Vec3 {
  const next: Vec3 = [...vector]
  next[axis] = value
  return next
}
