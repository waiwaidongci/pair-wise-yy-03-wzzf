export type Vec3 = [number, number, number]
export type ObjectType =
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'torus'
  | 'plane'
  | 'group'
  | 'directionalLight'
  | 'pointLight'
  | 'spotLight'
  | 'camera'
export type TransformMode = 'translate' | 'rotate' | 'scale'

export interface MaterialSpec {
  color: string
  roughness: number
  metalness: number
  opacity: number
  wireframe: boolean
}

/**
 * 实例在某个模板节点上的私有覆盖。只记录被单独调过的字段，
 * 其余字段始终跟随组合件源。material 内部再按属性粒度合并。
 */
export type OverridePatch = Partial<
  Pick<
    SceneObject,
    'position' | 'rotation' | 'scale' | 'visible' | 'castShadow' | 'receiveShadow' | 'intensity' | 'distance' | 'fov' | 'activeCamera'
  >
> & {
  material?: Partial<MaterialSpec>
  name?: never
}

export interface PrefabOverride {
  /** 模板节点路径：根之间以 / 分隔，节点 id 即路径段；单根模板的根路径是它自己的 id */
  nodePath: string
  patch: OverridePatch
}

export interface SceneObject {
  id: string
  name: string
  type: ObjectType
  parentId: string | null
  visible: boolean
  position: Vec3
  rotation: Vec3
  scale: Vec3
  castShadow: boolean
  receiveShadow: boolean
  material: MaterialSpec
  intensity?: number
  distance?: number
  fov?: number
  activeCamera?: boolean
  /** 非空时该对象是一个组合件引用实例的句柄 */
  instanceOf?: string | null
  /** 实例私有覆盖，仅实例句柄上生效 */
  overrides?: PrefabOverride[]
}

export interface PrefabAsset {
  id: string
  name: string
  /** 模板节点森林，可以有一个或多个根 */
  nodes: SceneObject[]
  createdAt: string
}

export interface SceneDocument {
  version: 2
  name: string
  objects: SceneObject[]
  prefabs: PrefabAsset[]
  savedAt: string
}

export interface PerformanceSettings {
  instanceMode: boolean
  shadows: boolean
  showGrid: boolean
  pixelRatio: number
}

/** 渲染现场快照：渲染失败后回滚到上一次成功渲染的状态 */
export interface SceneSnapshot {
  name: string
  objects: SceneObject[]
  prefabs: PrefabAsset[]
  selectedKey: string | null
  editingPrefabId: string | null
  cameraPosition: Vec3
  cameraTarget: Vec3
}

export type RenderPhase = 'idle' | 'batching' | 'recovering'

export interface RenderState {
  phase: RenderPhase
  done: number
  total: number
}
