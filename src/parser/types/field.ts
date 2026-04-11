// Field and JSON-path AST types.
//
// A `Field` is a column reference plus an optional JSON path walk.
// e.g. `data->'owner'->>'name'` becomes:
//   { name: 'data', jsonPath: [
//       { type: 'arrow',       operand: { type: 'key', value: 'owner' } },
//       { type: 'doubleArrow', operand: { type: 'key', value: 'name'  } },
//   ]}

export type FieldName = string;

export type JsonOperand =
  | { readonly type: 'key'; readonly value: string }
  | { readonly type: 'idx'; readonly value: string };

export type JsonOperation =
  | { readonly type: 'arrow'; readonly operand: JsonOperand }
  | { readonly type: 'doubleArrow'; readonly operand: JsonOperand };

export type JsonPath = readonly JsonOperation[];

export interface Field {
  readonly name: FieldName;
  readonly jsonPath: JsonPath;
}
