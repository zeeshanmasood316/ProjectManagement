import { state, mainContent } from './state.js';
import { api } from './api.js';
import { render } from './dispatch.js';
import { toast, closeDialog } from './ui.js';

export function getBoardDragAfterElement(container, y) {
  const cards = [...container.querySelectorAll('.board-task-card:not(.dragging)')];
  return cards.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

export function getColumnDragAfterElement(container, x) {
  const columns = [...container.querySelectorAll('.kanban-column:not(.column-dragging)')];
  return columns.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

export async function persistBoardMove(taskId, sourceColumnId, targetColumnId, orderedIdsInTargetColumn) {
  const targetColumn = state.boardColumns.find(item => Number(item.id) === Number(targetColumnId));
  const task = state.tasks.find(item => Number(item.id) === Number(taskId));
  if (!targetColumn || !task) { render(); return; }
  const previousTasks = state.tasks.map(item => ({ ...item }));
  orderedIdsInTargetColumn.forEach((id, index) => {
    const item = state.tasks.find(t => Number(t.id) === Number(id));
    if (!item) return;
    item.board_position = index;
    item.column_id = Number(targetColumnId);
    if (Number(id) === Number(taskId)) item.status = targetColumn.maps_to_status;
  });
  let sourceOrdered = [];
  if (sourceColumnId && Number(sourceColumnId) !== Number(targetColumnId)) {
    sourceOrdered = state.tasks
      .filter(item => Number(item.column_id) === Number(sourceColumnId) && Number(item.id) !== Number(taskId))
      .sort((a, b) => a.board_position - b.board_position);
    sourceOrdered.forEach((item, index) => { item.board_position = index; });
  }
  render();
  try {
    const requests = orderedIdsInTargetColumn.map((id, index) => {
      const body = Number(id) === Number(taskId) ? { column_id: Number(targetColumnId), board_position: index } : { board_position: index };
      return api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    });
    for (const item of sourceOrdered) requests.push(api(`/api/tasks/${item.id}`, { method: 'PATCH', body: JSON.stringify({ board_position: item.board_position }) }));
    await Promise.all(requests);
  } catch (error) {
    state.tasks = previousTasks;
    render();
    toast("Couldn't move task. Your previous position has been restored.", true);
  }
}

export async function persistColumnOrder(orderedIds) {
  const columnMap = new Map(state.boardColumns.map(column => [Number(column.id), column]));
  const reordered = orderedIds.map(id => columnMap.get(Number(id))).filter(Boolean);
  if (!reordered.length) return;
  const previous = state.boardColumns;
  state.boardColumns = reordered.map((column, position) => ({ ...column, position }));
  render();
  try {
    await Promise.all(reordered.map((column, position) => api(`/api/board-columns/${column.id}`, { method: 'PATCH', body: JSON.stringify({ position }) })));
    toast('Column order updated.');
  } catch (error) {
    state.boardColumns = previous;
    render();
    toast(error.message, true);
  }
}

export function moveColumnDirection(columnId, direction, overlay) {
  const sorted = [...state.boardColumns].sort((a, b) => a.position - b.position);
  const index = sorted.findIndex(item => Number(item.id) === Number(columnId));
  const swapIndex = index + direction;
  if (index === -1 || swapIndex < 0 || swapIndex >= sorted.length) return;
  const ids = sorted.map(item => item.id);
  [ids[index], ids[swapIndex]] = [ids[swapIndex], ids[index]];
  if (overlay) closeDialog(overlay);
  persistColumnOrder(ids);
}

export let draggedBoardTaskId = null;
export let draggedBoardTaskSourceColumnId = null;
mainContent.addEventListener('dragstart', event => {
  const card = event.target.closest('[data-drag-board-task]');
  if (!card) return;
  draggedBoardTaskId = Number(card.dataset.dragBoardTask);
  draggedBoardTaskSourceColumnId = Number(card.closest('[data-drop-board-column]')?.dataset.dropBoardColumn) || null;
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
mainContent.addEventListener('dragover', event => {
  if (draggedBoardTaskId === null) return;
  const zone = event.target.closest('[data-drop-board-column]');
  if (!zone) return;
  event.preventDefault();
  const filters = state.taskFilters || {};
  const filterActive = Boolean(filters.story && filters.story !== 'all');
  const targetColumnId = Number(zone.dataset.dropBoardColumn);
  if (filterActive && targetColumnId === draggedBoardTaskSourceColumnId) return;
  mainContent.querySelectorAll('.kanban-column-body.body-drag-over').forEach(el => { if (el !== zone) el.classList.remove('body-drag-over'); });
  zone.classList.add('body-drag-over');
});
mainContent.addEventListener('drop', async event => {
  if (draggedBoardTaskId === null) return;
  const zone = event.target.closest('[data-drop-board-column]');
  if (!zone) return;
  event.preventDefault();
  const targetColumnId = Number(zone.dataset.dropBoardColumn);
  const sourceColumnId = draggedBoardTaskSourceColumnId;
  const taskId = draggedBoardTaskId;
  draggedBoardTaskId = null;
  draggedBoardTaskSourceColumnId = null;
  const filters = state.taskFilters || {};
  const filterActive = Boolean(filters.story && filters.story !== 'all');
  if (filterActive && targetColumnId === sourceColumnId) { render(); return; }
  const existingIds = [...zone.querySelectorAll('[data-drag-board-task]')].map(el => Number(el.dataset.dragBoardTask)).filter(id => id !== taskId);
  const afterElement = getBoardDragAfterElement(zone, event.clientY);
  let insertIndex = existingIds.length;
  if (afterElement) {
    const afterId = Number(afterElement.dataset.dragBoardTask);
    const foundIndex = existingIds.indexOf(afterId);
    if (foundIndex !== -1) insertIndex = foundIndex;
  }
  const orderedIds = [...existingIds];
  orderedIds.splice(insertIndex, 0, taskId);
  await persistBoardMove(taskId, sourceColumnId, targetColumnId, orderedIds);
});
mainContent.addEventListener('dragend', event => {
  mainContent.querySelectorAll('.kanban-column-body.body-drag-over').forEach(el => el.classList.remove('body-drag-over'));
  const card = event.target.closest('[data-drag-board-task]');
  card?.classList.remove('dragging');
  draggedBoardTaskId = null;
  draggedBoardTaskSourceColumnId = null;
});

export let draggedColumnId = null;
mainContent.addEventListener('dragstart', event => {
  const handle = event.target.closest('[data-drag-column]');
  if (!handle) return;
  draggedColumnId = Number(handle.dataset.dragColumn);
  event.dataTransfer.effectAllowed = 'move';
  handle.closest('.kanban-column')?.classList.add('column-dragging');
});
mainContent.addEventListener('dragover', event => {
  if (draggedColumnId === null) return;
  const board = event.target.closest('.kanban-board');
  if (!board) return;
  event.preventDefault();
});
mainContent.addEventListener('drop', async event => {
  if (draggedColumnId === null) return;
  const board = event.target.closest('.kanban-board');
  if (!board) return;
  event.preventDefault();
  const columnId = draggedColumnId;
  draggedColumnId = null;
  const existingIds = [...board.querySelectorAll('[data-column-id]')].map(el => Number(el.dataset.columnId)).filter(id => id !== columnId);
  const afterElement = getColumnDragAfterElement(board, event.clientX);
  let insertIndex = existingIds.length;
  if (afterElement) {
    const afterId = Number(afterElement.dataset.columnId);
    const foundIndex = existingIds.indexOf(afterId);
    if (foundIndex !== -1) insertIndex = foundIndex;
  }
  const orderedIds = [...existingIds];
  orderedIds.splice(insertIndex, 0, columnId);
  await persistColumnOrder(orderedIds);
});
mainContent.addEventListener('dragend', event => {
  const col = event.target.closest('.kanban-column');
  col?.classList.remove('column-dragging');
  draggedColumnId = null;
});

export let draggedStoryId = null;
mainContent.addEventListener('dragstart', event => {
  const card = event.target.closest('[data-drag-story]');
  if (!card) return;
  draggedStoryId = Number(card.dataset.dragStory);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
mainContent.addEventListener('dragend', event => {
  event.target.closest('[data-drag-story]')?.classList.remove('dragging');
});
mainContent.addEventListener('dragover', event => {
  if (!event.target.closest('[data-drop-story]')) return;
  event.preventDefault();
});
mainContent.addEventListener('drop', async event => {
  const zone = event.target.closest('[data-drop-story]');
  if (!zone || draggedStoryId === null) return;
  event.preventDefault();
  const targetId = Number(zone.dataset.dropStory);
  const sourceId = draggedStoryId;
  draggedStoryId = null;
  if (targetId === sourceId) return;
  const reordered = [...state.stories];
  const fromIndex = reordered.findIndex(story => Number(story.id) === sourceId);
  const toIndex = reordered.findIndex(story => Number(story.id) === targetId);
  if (fromIndex === -1 || toIndex === -1) return;
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  const previous = state.stories;
  state.stories = reordered;
  render();
  try {
    await Promise.all(reordered.map((story, index) => api(`/api/stories/${story.id}`, { method: 'PATCH', body: JSON.stringify({ position: index }) })));
    toast('Story order updated.');
  } catch (error) {
    state.stories = previous;
    render();
    toast(error.message, true);
  }
});
