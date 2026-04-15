// SQL fragment renderers — one file per fragment kind.
//
// This file is a thin barrel. Adding a new fragment renderer means
// creating a new file under `builder/fragments/` and re-exporting
// it here.

export { renderField } from './fragments/field';
export {
  renderFilter,
  renderOpExpr,
  renderOpExprOnExpr,
} from './fragments/filter';
export { renderLogicTree } from './fragments/logic';
export {
  renderLimitOffset,
  renderOrderClause,
  renderOrderTerm,
} from './fragments/order';
export {
  renderGroupBy,
  renderGroupByFromProjection,
  renderSelectProjection,
  renderSelectProjectionAndGrouping,
  type RenderedProjection,
} from './fragments/select';
export { renderHaving } from './fragments/having';
export { isValidCast, buildPgArrayLiteral } from './fragments/operators';
