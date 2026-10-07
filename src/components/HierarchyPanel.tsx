import {
  Box,
  Button,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  AddBoxOutlined,
  CameraAltOutlined,
  DeleteOutline,
  DifferenceOutlined,
  EditOutlined,
  ExpandMore,
  HubOutlined,
  LightModeOutlined,
  Visibility,
  VisibilityOff,
} from '@mui/icons-material'
import { useMemo, useState } from 'react'
import type { ObjectType, SceneObject } from '../types/scene'
import { useEditorStore } from '../stores/editor'
import { TYPE_LABELS } from '../utils/scene'

function ObjectRow({ object, depth, editableList }: { object: SceneObject; depth: number; editableList: SceneObject[] }) {
  const selectedKey = useEditorStore((state) => state.selectedKey)
  const selectedKeys = useEditorStore((state) => state.selectedKeys)
  const select = useEditorStore((state) => state.select)
  const updateNode = useEditorStore((state) => state.updateNode)
  const remove = useEditorStore((state) => state.remove)
  const reparent = useEditorStore((state) => state.reparent)
  const enterPrefab = useEditorStore((state) => state.enterPrefab)
  const prefabs = useEditorStore((state) => state.prefabs)
  const [expanded, setExpanded] = useState(true)
  const children = useMemo(() => editableList.filter((item) => item.parentId === object.id), [editableList, object.id])
  const isLight = object.type.includes('Light')
  const isCamera = object.type === 'camera'
  const isInstance = Boolean(object.instanceOf)
  const prefab = prefabs.find((item) => item.id === object.instanceOf)

  return (
    <>
      <ListItemButton
        draggable
        selected={selectedKey === object.id}
        onDragStart={(event) => event.dataTransfer.setData('application/x-scene-object', object.id)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          const id = event.dataTransfer.getData('application/x-scene-object')
          if (id) reparent(id, object.id)
        }}
        onClick={(event) => select(object.id, event.shiftKey)}
        sx={{ pl: 1 + depth * 1.6, minHeight: 34, borderBottom: '1px solid #edf0f4', pr: 0.4 }}
      >
        {children.length > 0 ? (
          <IconButton
            size="small"
            onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value) }}
            sx={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: '.15s' }}
          >
            <ExpandMore fontSize="inherit" />
          </IconButton>
        ) : (
          <Box sx={{ width: 26 }} />
        )}
        <Box sx={{
          mr: 0.8,
          display: 'grid',
          placeItems: 'center',
          color: isInstance ? '#7c3aed' : isLight ? '#d97706' : isCamera ? '#0284c7' : '#2563eb',
        }}
        >
          {isInstance ? <DifferenceOutlined fontSize="small" /> : isLight ? <LightModeOutlined fontSize="small" /> : isCamera ? <CameraAltOutlined fontSize="small" /> : <AddBoxOutlined fontSize="small" />}
        </Box>
        <ListItemText
          primary={
            <span style={{ fontWeight: selectedKeys.includes(object.id) ? 700 : 600 }}>
              {object.name}
              {selectedKeys.includes(object.id) && selectedKeys.length > 1 ? ' ✓' : ''}
            </span>
          }
          secondary={isInstance && prefab ? `引用实例 · ${prefab.name}` : TYPE_LABELS[object.type]}
          slotProps={{ primary: { fontSize: 12 }, secondary: { fontSize: 10 } }}
        />
        {isInstance && (
          <Tooltip title="编辑组合件源">
            <IconButton size="small" color="secondary" onClick={(event) => {
              event.stopPropagation()
              if (object.instanceOf) enterPrefab(object.instanceOf)
            }}
            >
              <EditOutlined fontSize="inherit" />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={object.visible ? '隐藏' : '显示'}>
          <IconButton size="small" onClick={(event) => { event.stopPropagation(); updateNode(object.id, { visible: !object.visible }) }}>
            {object.visible ? <Visibility fontSize="inherit" /> : <VisibilityOff fontSize="inherit" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="删除">
          <IconButton size="small" color="error" onClick={(event) => { event.stopPropagation(); remove(object.id) }}>
            <DeleteOutline fontSize="inherit" />
          </IconButton>
        </Tooltip>
      </ListItemButton>
      {expanded && children.map((child) => (
        <ObjectRow key={child.id} object={child} depth={depth + 1} editableList={editableList} />
      ))}
    </>
  )
}

export default function HierarchyPanel() {
  const objects = useEditorStore((state) => state.objects)
  const prefabs = useEditorStore((state) => state.prefabs)
  const selectedKeys = useEditorStore((state) => state.selectedKeys)
  const add = useEditorStore((state) => state.add)
  const addPrefabInstance = useEditorStore((state) => state.addPrefabInstance)
  const createPrefabFromSelection = useEditorStore((state) => state.createPrefabFromSelection)
  const enterPrefab = useEditorStore((state) => state.enterPrefab)
  const exitPrefab = useEditorStore((state) => state.exitPrefab)
  const editingPrefabId = useEditorStore((state) => state.editingPrefabId)

  const editingAsset = prefabs.find((item) => item.id === editingPrefabId)
  const editableList: SceneObject[] = editingAsset ? editingAsset.nodes : objects
  const roots = editableList.filter((object) => !object.parentId)
  const countGeometry = editableList.filter((object) => !object.type.includes('Light') && object.type !== 'camera' && object.type !== 'group').length

  return (
    <aside className="panel hierarchy-panel">
      <div className="panel-heading">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <HubOutlined fontSize="small" color={editingAsset ? 'secondary' : 'primary'} />
          <div>
            <Typography variant="subtitle2">{editingAsset ? `组合件源：${editingAsset.name}` : '场景层级'}</Typography>
            <Typography variant="caption" color="text.secondary">
              {editableList.length} 个节点 · {countGeometry} 个几何体
            </Typography>
          </div>
        </Box>
      </div>

      {editingAsset ? (
        <Stack direction="row" spacing={0.5} sx={{ mb: 1 }}>
          <Button fullWidth size="small" variant="contained" onClick={exitPrefab}>完成编辑，返回场景</Button>
        </Stack>
      ) : (
        <Button
          fullWidth
          size="small"
          variant="contained"
          color="secondary"
          startIcon={<DifferenceOutlined />}
          onClick={() => createPrefabFromSelection()}
          sx={{ mb: 1 }}
          disabled={selectedKeys.filter((key) => !key.startsWith('instance:')).length === 0}
        >
          把选中的 {selectedKeys.filter((key) => !key.startsWith('instance:')).length || ''} 个对象做成组合件
        </Button>
      )}

      <Stack direction="row" spacing={0.5} sx={{ mb: 1, flexWrap: 'wrap' }}>
        {(['box', 'sphere', 'cylinder', 'cone', 'torus'] as ObjectType[]).map((type) => (
          <Button key={type} size="small" variant="outlined" onClick={() => add(type, selectedKeys[0] ?? null)}>{TYPE_LABELS[type]}</Button>
        ))}
      </Stack>
      <Stack direction="row" spacing={0.5} sx={{ mb: 1.2 }}>
        <Button size="small" onClick={() => add('directionalLight', selectedKeys[0] ?? null)}>平行光</Button>
        <Button size="small" onClick={() => add('pointLight', selectedKeys[0] ?? null)}>点光源</Button>
        <Button size="small" onClick={() => add('camera', selectedKeys[0] ?? null)}>相机</Button>
      </Stack>

      {!editingAsset && prefabs.length > 0 && (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>组合件库（点击放置引用实例）</Typography>
          <Stack direction="row" spacing={0.5} sx={{ mb: 1.2, mt: 0.4, flexWrap: 'wrap', gap: 0.5 }}>
            {prefabs.map((asset) => {
              const usage = objects.filter((object) => object.instanceOf === asset.id).length
              return (
                <Tooltip key={asset.id} title={`场景中有 ${usage} 个引用实例`}>
                  <Button
                    size="small"
                    variant="outlined"
                    color="secondary"
                    startIcon={<DifferenceOutlined />}
                    onClick={() => addPrefabInstance(asset.id)}
                    onDoubleClick={() => enterPrefab(asset.id)}
                  >
                    {asset.name}
                    <Typography component="span" variant="caption" sx={{ ml: 0.5, opacity: 0.7 }}>×{usage}</Typography>
                  </Button>
                </Tooltip>
              )
            })}
          </Stack>
        </>
      )}

      <Typography variant="caption" color="text.secondary">
        {editingAsset
          ? '源的改动会传播到所有未单独覆盖的实例'
          : 'Shift 点选多个对象 · 拖动行调整父子关系 · 双击组合件进入源编辑'}
      </Typography>
      <List dense disablePadding sx={{ mt: 1 }}>
        {roots.map((object) => <ObjectRow key={object.id} object={object} depth={0} editableList={editableList} />)}
      </List>
    </aside>
  )
}
