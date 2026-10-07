import { Box, Button, Chip, IconButton, List, ListItemButton, ListItemText, Stack, Tooltip, Typography } from '@mui/material'
import { AddBoxOutlined, CameraAltOutlined, DeleteOutline, DiamondOutlined, ExpandMore, LightModeOutlined, Visibility, VisibilityOff, WidgetsOutlined } from '@mui/icons-material'
import { useMemo, useState } from 'react'
import type { ObjectType, SceneObject } from '../types/scene'
import { useEditorStore } from '../stores/editor'
import { TYPE_LABELS } from '../utils/scene'
import { countInstances } from '../utils/components'

function ObjectRow({ object, depth }: { object: SceneObject; depth: number }) {
  const selectedId = useEditorStore((state) => state.selectedId)
  const select = useEditorStore((state) => state.select)
  const update = useEditorStore((state) => state.update)
  const remove = useEditorStore((state) => state.remove)
  const reparent = useEditorStore((state) => state.reparent)
  const [expanded, setExpanded] = useState(true)
  const objects = useEditorStore((state) => state.objects)
  const children = useMemo(() => objects.filter((item) => item.parentId === object.id), [objects, object.id])
  const isLight = object.type.includes('Light')
  const isCamera = object.type === 'camera'
  const isInstance = Boolean(object.componentId)
  const overrides = object.overrides

  return (
    <>
      <ListItemButton
        draggable
        selected={selectedId === object.id}
        onDragStart={(event) => event.dataTransfer.setData('application/x-scene-object', object.id)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          const id = event.dataTransfer.getData('application/x-scene-object')
          if (id) reparent(id, object.id)
        }}
        onClick={() => select(object.id)}
        sx={{ pl: 1 + depth * 1.6, minHeight: 34, borderBottom: '1px solid #edf0f4' }}
      >
        {children.length > 0 && (
          <IconButton
            size="small"
            onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value) }}
            sx={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: '.15s' }}
          >
            <ExpandMore fontSize="inherit" />
          </IconButton>
        )}
        <Box sx={{ mr: 0.8, display: 'grid', placeItems: 'center', color: isInstance ? '#7c3aed' : isLight ? '#d97706' : isCamera ? '#0284c7' : '#2563eb' }}>
          {isInstance ? <DiamondOutlined fontSize="small" /> : isLight ? <LightModeOutlined fontSize="small" /> : isCamera ? <CameraAltOutlined fontSize="small" /> : <AddBoxOutlined fontSize="small" />}
        </Box>
        <ListItemText
          primary={object.name}
          secondary={isInstance ? '引用实例' : TYPE_LABELS[object.type]}
          slotProps={{ primary: { fontSize: 12, fontWeight: 600 }, secondary: { fontSize: 10 } }}
        />
        {isInstance && (overrides?.position || overrides?.material) && (
          <Stack direction="row" spacing={0.3} sx={{ mr: 0.5 }}>
            {overrides.position && <Chip size="small" label="位置" sx={{ height: 16, fontSize: 9 }} />}
            {overrides.material && <Chip size="small" label="材质" sx={{ height: 16, fontSize: 9 }} />}
          </Stack>
        )}
        <Tooltip title={object.visible ? '隐藏' : '显示'}>
          <IconButton size="small" onClick={(event) => { event.stopPropagation(); update(object.id, { visible: !object.visible }) }}>
            {object.visible ? <Visibility fontSize="inherit" /> : <VisibilityOff fontSize="inherit" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="删除">
          <IconButton size="small" color="error" onClick={(event) => { event.stopPropagation(); remove(object.id) }}>
            <DeleteOutline fontSize="inherit" />
          </IconButton>
        </Tooltip>
      </ListItemButton>
      {expanded && children.map((child) => <ObjectRow key={child.id} object={child} depth={depth + 1} />)}
    </>
  )
}

function ComponentLibrary() {
  const components = useEditorStore((state) => state.components)
  const objects = useEditorStore((state) => state.objects)
  const editingComponentId = useEditorStore((state) => state.editingComponentId)
  const placeInstance = useEditorStore((state) => state.placeInstance)
  const startEditComponent = useEditorStore((state) => state.startEditComponent)
  const removeComponent = useEditorStore((state) => state.removeComponent)

  if (components.length === 0) return null
  return (
    <Box sx={{ mt: 1.2, mb: 0.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <WidgetsOutlined fontSize="inherit" /> 组合件库
      </Typography>
      <List dense disablePadding sx={{ mt: 0.5 }}>
        {components.map((component) => {
          const count = countInstances(component.id, objects)
          const editing = editingComponentId === component.id
          return (
            <ListItemButton key={component.id} sx={{ pl: 1, minHeight: 32, borderBottom: '1px solid #edf0f4' }}>
              <ListItemText
                primary={component.name}
                secondary={`${count} 个引用实例`}
                slotProps={{ primary: { fontSize: 12, fontWeight: 600 }, secondary: { fontSize: 10 } }}
              />
              {editing && <Chip size="small" color="primary" label="编辑中" sx={{ height: 18, fontSize: 9, mr: 0.5 }} />}
              <Tooltip title="放置引用实例">
                <IconButton size="small" onClick={() => placeInstance(component.id)}><AddBoxOutlined fontSize="small" /></IconButton>
              </Tooltip>
              <Tooltip title="编辑组合件">
                <IconButton size="small" onClick={() => startEditComponent(component.id)}><WidgetsOutlined fontSize="small" /></IconButton>
              </Tooltip>
              <Tooltip title="删除组合件">
                <IconButton size="small" color="error" onClick={() => removeComponent(component.id)}><DeleteOutline fontSize="small" /></IconButton>
              </Tooltip>
            </ListItemButton>
          )
        })}
      </List>
    </Box>
  )
}

export default function HierarchyPanel() {
  const objects = useEditorStore((state) => state.objects)
  const selectedId = useEditorStore((state) => state.selectedId)
  const add = useEditorStore((state) => state.add)
  const editingComponentId = useEditorStore((state) => state.editingComponentId)
  const components = useEditorStore((state) => state.components)
  const finishEditComponent = useEditorStore((state) => state.finishEditComponent)
  const roots = objects.filter((object) => !object.parentId)
  const countGeometry = objects.filter((object) => !object.type.includes('Light') && object.type !== 'camera').length
  const editingName = components.find((item) => item.id === editingComponentId)?.name

  return (
    <aside className="panel hierarchy-panel">
      <div className="panel-heading">
        <div><Typography variant="subtitle2">场景层级</Typography><Typography variant="caption" color="text.secondary">{objects.length} 个对象 · {countGeometry} 个几何体</Typography></div>
      </div>
      {editingComponentId && (
        <Box sx={{ mb: 1, p: 0.8, borderRadius: 1, bgcolor: '#eef2ff', border: '1px solid #c7d2fe' }}>
          <Typography variant="caption" sx={{ display: 'block', mb: 0.6, color: '#3730a3' }}>
            正在编辑组合件「{editingName}」
          </Typography>
          <Stack direction="row" spacing={0.5}>
            <Button size="small" variant="contained" onClick={() => finishEditComponent(true)}>完成编辑</Button>
            <Button size="small" onClick={() => finishEditComponent(false)}>取消</Button>
          </Stack>
        </Box>
      )}
      <Stack direction="row" spacing={0.5} sx={{ mb: 1, flexWrap: 'wrap' }}>
        {(['box', 'sphere', 'cylinder', 'cone', 'torus'] as ObjectType[]).map((type) => (
          <Button key={type} size="small" variant="outlined" onClick={() => add(type, selectedId)}>{TYPE_LABELS[type]}</Button>
        ))}
      </Stack>
      <Stack direction="row" spacing={0.5} sx={{ mb: 1.2 }}>
        <Button size="small" onClick={() => add('directionalLight', selectedId)}>平行光</Button>
        <Button size="small" onClick={() => add('pointLight', selectedId)}>点光源</Button>
        <Button size="small" onClick={() => add('camera', selectedId)}>相机</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">拖动物体到另一行可调整父子关系</Typography>
      <List dense disablePadding sx={{ mt: 1 }}>
        {roots.map((object) => <ObjectRow key={object.id} object={object} depth={0} />)}
      </List>
      <ComponentLibrary />
    </aside>
  )
}
