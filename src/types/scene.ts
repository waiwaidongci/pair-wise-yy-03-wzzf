export type Vec3 = [number, number, number]
export type ObjectType = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane' | 'directionalLight' | 'pointLight' | 'spotLight' | 'camera'
export type TransformMode = 'translate' | 'rotate' | 'scale'

export interface MaterialSpec {
  color: string
  roughness: number
  metalness: number
  opacity: number
  wireframe: boolean
}

/**
 * 引用实例的覆盖状态。
 * position 为 true 时，位置/旋转/缩放使用实例自身的值，不再跟随组合件源。
 * material 为 true 时，材质使用实例自身的值，源改动盖不掉。
 */
export interface OverrideState {
  position: boolean
  material: boolean
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
  /** 若存在，表示该对象是某个组合件的引用实例 */
  componentId?: string
  /** 实例相对源组合件的覆盖标记 */
  overrides?: OverrideState
}

/** 组合件模板节点：模板是一棵自包含的子树 */
export interface ComponentTemplateNode {
  object: SceneObject
  children: ComponentTemplateNode[]
}

/** 组合件定义（资产），场景中的引用实例通过 componentId 引用它 */
export interface ComponentDef {
  id: string
  name: string
  root: ComponentTemplateNode
}

export interface SceneDocument {
  /** 1 = 旧数据（无组合件），2 = 含组合件库 */
  version: 1 | 2
  name: string
  objects: SceneObject[]
  components: ComponentDef[]
  savedAt: string
}

export interface PerformanceSettings {
  instanceMode: boolean
  shadows: boolean
  showGrid: boolean
  pixelRatio: number
}
