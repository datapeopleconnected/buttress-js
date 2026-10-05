// How a core route may use Model.getCoreModel(): only for what touches no rows. Core collections are shared by every
// app, so rows are reached through this.scoped(req, Model), which limits them to the caller's app, or
// this.unscopedModel(Model, reason). See .ai/routing.md.

// What a route may take from Model.getCoreModel(X) itself
export const coreModelMembersWithoutRows = [
  'schemaData',
  'flatSchemaData',
  'Constants',
  'createId',
  'isValidId',
  'validate',
  'validateUpdate',
  'parseQuery',
  'createTokenString',
];

const message =
  "Reach a core model's rows through this.scoped(req, Model), or this.unscopedModel(Model, reason) for a route that " +
  'reaches every app. Model.getCoreModel() is for what touches no rows: ' +
  coreModelMembersWithoutRows.join(', ') +
  '.';

const getCoreModelCall = "CallExpression[callee.property.name='getCoreModel']";

// For no-restricted-syntax
export const coreModelAccessRestrictions = [
  {
    // Model.getCoreModel(X).find(...), .updatePolicyProperties(...), ...
    selector:
      `MemberExpression[object.type='CallExpression'][object.callee.property.name='getCoreModel']` +
      `[property.name!=/^(${coreModelMembersWithoutRows.join('|')})$/]`,
    message,
  },
  {
    // The model itself kept or passed on: const lambdas = Model.getCoreModel(X), ACM.find(Model.getCoreModel(X), ...)
    selector: `:not(MemberExpression) > ${getCoreModelCall}`,
    message,
  },
];
