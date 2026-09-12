import { parseRef } from "@redocly/openapi-core/lib/ref-utils.js";
import {
  addJSDocComment,
  BOOLEAN,
  INDENT,
  indexSignature,
  isWithRequiredObjectHelper,
  NEVER,
  NULL,
  NUMBER,
  oapiRef,
  propertySignature,
  STRING,
  type TSNode,
  tsArray,
  tsArrayLiteralExpression,
  tsEnum,
  tsIntersection,
  tsIsPrimitive,
  tsLiteral,
  tsNullable,
  tsOmit,
  tsParenthesize,
  tsPropertyIndex,
  tsRecord,
  tsUnion,
  tsWithRequired,
  tsWithRequiredObject,
  tupleType,
  typeLiteral,
  UNDEFINED,
  UNKNOWN,
} from "../lib/ts.js";
import { createDiscriminatorProperty, createRef, getEntries } from "../lib/utils.js";
import type { PropertySignatureLike, ReferenceObject, SchemaObject, TransformNodeOptions } from "../types.js";

/** Record hook replacements without probing or replaying user callbacks. */
interface TransformObserver {
  replaced: boolean;
}

/**
 * Transform SchemaObject nodes (4.8.24)
 * @see https://spec.openapis.org/oas/v3.1.0#schema-object
 */
export default function transformSchemaObject(
  schemaObject: SchemaObject | ReferenceObject,
  options: TransformNodeOptions,
  fromAdditionalProperties = false,
  indent = "",
): TSNode {
  return transformSchemaObjectObserved(schemaObject, options, fromAdditionalProperties, undefined, true, indent);
}

function transformSchemaObjectObserved(
  schemaObject: SchemaObject | ReferenceObject,
  options: TransformNodeOptions,
  fromAdditionalProperties = false,
  observer?: TransformObserver,
  allowCoreObjectAssertion = true,
  indent = "",
): TSNode {
  const type = transformSchemaObjectWithCompositionObserved(
    schemaObject,
    options,
    fromAdditionalProperties,
    observer,
    allowCoreObjectAssertion,
    indent,
  );
  if (typeof options.ctx.postTransform === "function") {
    const postTransformResult = options.ctx.postTransform(type, options);
    if (postTransformResult) {
      // Returning the observed source is informational; only changed source replaces this occurrence.
      if (observer && postTransformResult !== type) {
        observer.replaced = true;
      }
      return postTransformResult;
    }
  }
  return type;
}

/**
 * Transform SchemaObjects
 */
export function transformSchemaObjectWithComposition(
  schemaObject: SchemaObject | ReferenceObject,
  options: TransformNodeOptions,
  fromAdditionalProperties = false,
  indent = "",
): TSNode {
  return transformSchemaObjectWithCompositionObserved(
    schemaObject,
    options,
    fromAdditionalProperties,
    undefined,
    true,
    indent,
  );
}

function transformSchemaObjectWithCompositionObserved(
  schemaObject: SchemaObject | ReferenceObject,
  options: TransformNodeOptions,
  fromAdditionalProperties = false,
  observer?: TransformObserver,
  allowCoreObjectAssertion = true,
  indent = "",
): TSNode {
  /**
   * Unexpected types & edge cases
   */

  // missing/falsy type returns `never`
  if (!schemaObject) {
    return NEVER;
  }
  // `true` returns `unknown` (this exists, but is untyped)
  if ((schemaObject as unknown) === true) {
    return UNKNOWN;
  }
  // for any other unexpected type, throw error
  if (Array.isArray(schemaObject) || typeof schemaObject !== "object") {
    throw new Error(
      `Expected SchemaObject, received ${Array.isArray(schemaObject) ? "Array" : typeof schemaObject} at ${options.path}`,
    );
  }

  /**
   * ReferenceObject
   */
  if ("$ref" in schemaObject) {
    return oapiRef(schemaObject.$ref, undefined, { indent });
  }

  /**
   * const (valid for any type)
   */
  if (schemaObject.const !== null && schemaObject.const !== undefined) {
    return tsLiteral(schemaObject.const, indent);
  }

  /**
   * enum (non-objects)
   * note: enum is valid for any type, but for objects, handle in oneOf below
   */
  if (
    Array.isArray(schemaObject.enum) &&
    (!("type" in schemaObject) || schemaObject.type !== "object") &&
    !("properties" in schemaObject)
  ) {
    const hasAdditionalProperties = "additionalProperties" in schemaObject && !!schemaObject.additionalProperties;

    if (!hasAdditionalProperties || (schemaObject.type === "string" && hasAdditionalProperties)) {
      // hoist enum to top level if string/number enum and option is enabled
      if (shouldTransformToTsEnum(options, schemaObject)) {
        let enumName = parseRef(options.path ?? "").pointer.join("/");
        // allow #/components/schemas to have simpler names
        enumName = enumName.replace("components/schemas", "");
        const metadata = schemaObject.enum.map((_, i) => ({
          name: schemaObject["x-enum-varnames"]?.[i] ?? schemaObject["x-enumNames"]?.[i],
          description: schemaObject["x-enum-descriptions"]?.[i] ?? schemaObject["x-enumDescriptions"]?.[i],
        }));

        // enums can contain null values, but dont want to output them
        let hasNull = false;
        const validSchemaEnums = schemaObject.enum.filter((enumValue) => {
          if (enumValue === null) {
            hasNull = true;
            return false;
          }

          return true;
        });
        const enumType = tsEnum(enumName, validSchemaEnums as (string | number)[], metadata, {
          shouldCache: options.ctx.dedupeEnums,
          export: true,
          // readonly: TS enum do not support the readonly modifier
        });
        if (!options.ctx.injectFooter.includes(enumType.declaration)) {
          options.ctx.injectFooter.push(enumType.declaration);
        }
        const ref = enumType.name;

        const finalType: TSNode = hasNull ? tsUnion([ref, NULL]) : ref;

        return applyAdditionalPropertiesToEnum(hasAdditionalProperties, finalType, schemaObject);
      }

      const enumType = schemaObject.enum.map((v) => tsLiteral(v, indent));
      if ((Array.isArray(schemaObject.type) && schemaObject.type.includes("null")) || schemaObject.nullable) {
        enumType.push(NULL);
      }

      const unionType = applyAdditionalPropertiesToEnum(hasAdditionalProperties, tsUnion(enumType), schemaObject);

      // hoist array with valid enum values to top level if string/number enum and option is enabled
      if (options.ctx.enumValues && schemaObject.enum.every((v) => typeof v === "string" || typeof v === "number")) {
        const parsed = parseRef(options.path ?? "");
        let enumValuesVariableName = parsed.pointer.join("/");
        // allow #/components/schemas to have simpler names
        enumValuesVariableName = enumValuesVariableName.replace("components/schemas", "");
        enumValuesVariableName = `${enumValuesVariableName}Values`;

        // build a ref path for the type that ignores union indices (anyOf/oneOf) so
        // type references remain stable even when names include union positions
        const cleanedPointer: string[] = [];
        // Track ALL properties after a oneOf/anyOf that need Extract<> narrowing.
        // We apply Extract<> before EVERY property access after a union index because:
        // - When the property exists on ALL variants, Extract<> is a no-op (returns same type)
        // - When the property only exists on SOME variants, it correctly narrows the union
        // - When both variants have same property name but different inner schemas,
        //   we still narrow at each level to handle nested unions correctly
        // This robust approach handles both simple and complex union structures.
        const extractProperties: string[] = [];
        for (let i = 0; i < parsed.pointer.length; i++) {
          // Example: #/paths/analytics/data/get/responses/400/content/application/json/anyOf/0/message
          const segment = parsed.pointer[i];
          if ((segment === "anyOf" || segment === "oneOf") && i < parsed.pointer.length - 1) {
            const next = parsed.pointer[i + 1];
            if (/^\d+$/.test(next)) {
              // If we encounter something like "anyOf/0", we want to skip that part of the path
              i++;
              // Collect ALL remaining segments after the union index.
              // Each one will be wrapped with Extract<> to safely narrow the type
              // at each level, handling both top-level and nested union variants.
              const remainingSegments = parsed.pointer.slice(i + 1);
              for (const seg of remainingSegments) {
                // Skip union keywords and indices, only add actual property names
                if (seg !== "anyOf" && seg !== "oneOf" && !/^\d+$/.test(seg)) {
                  extractProperties.push(seg);
                }
              }
              continue;
            }
          }
          cleanedPointer.push(segment);
        }
        const cleanedRefPath = createRef(cleanedPointer);

        const enumValuesArray = tsArrayLiteralExpression(
          enumValuesVariableName,
          // If fromAdditionalProperties is true we are dealing with a record type and we should append [string] to the generated type
          fromAdditionalProperties
            ? `${oapiRef(cleanedRefPath, undefined, { deep: true, extractProperties })}[string]`
            : oapiRef(cleanedRefPath, undefined, { deep: true, extractProperties }),
          schemaObject.enum as (string | number)[],
          {
            export: true,
            readonly: true,
            injectFooter: options.ctx.injectFooter,
          },
        );

        options.ctx.injectFooter.push(enumValuesArray);
      }

      return unionType;
    }
  }

  /**
   * Object + composition (anyOf/allOf/oneOf) types
   */

  /** Collect oneOf/anyOf */
  function collectUnionCompositions(items: (SchemaObject | ReferenceObject)[], unionKey: "anyOf" | "oneOf") {
    const output: TSNode[] = [];
    for (const [index, item] of items.entries()) {
      output.push(
        transformSchemaObject(
          item,
          {
            ...options,
            // include index in path so generated names from nested enums/enumValues are unique
            path: createRef([options.path, unionKey, String(index)]),
          },
          false,
          indent,
        ),
      );
    }

    return output;
  }

  /** Collect allOf with Omit<> for discriminators */
  function collectAllOfCompositions(
    items: (SchemaObject | ReferenceObject)[],
    required?: string[],
    translatedRequiredConstraintItems?: Set<SchemaObject | ReferenceObject>,
    discoverRequiredKeys = false,
    constraintRequiredKeys?: Set<string>,
  ): TSNode[] {
    const output: TSNode[] = [];
    for (const item of items) {
      if (translatedRequiredConstraintItems?.has(item)) {
        // Its required assertion is represented through the normal parent-required flow below.
        continue;
      }

      let itemType: TSNode;
      // if this is a $ref, use WithRequired<X, Y> if parent specifies required properties
      // (but only for valid keys)
      if ("$ref" in item) {
        itemType = transformSchemaObject(item, options, false, indent);
        itemType = applyRequiredToRef(item, itemType, required, discoverRequiredKeys, constraintRequiredKeys);
      }
      // otherwise, if this is a schema object, combine parent `required[]` with its own, if any
      else {
        const itemRequired = [...(required ?? [])];
        if (typeof item === "object" && Array.isArray(item.required)) {
          itemRequired.push(...item.required);
        }
        itemType = transformSchemaObject({ ...item, required: itemRequired }, options, false, indent);
      }

      const discriminator =
        ("$ref" in item && options.ctx.discriminators.objects[item.$ref]) || (item as any).discriminator;
      if (discriminator) {
        output.push(tsOmit(itemType, [discriminator.propertyName]));
      } else {
        output.push(itemType);
      }
    }
    return output;
  }

  /**
   * Transform callback-sensitive occurrences once before deciding which typed constraints can be removed.
   * Store results by occurrence index because a stateful callback may transform the same schema object differently
   * when that object is reused in allOf.
   */
  function collectCallbackAwareAllOfCompositions(
    items: (SchemaObject | ReferenceObject)[],
    candidateConstraints: Map<number, string[]>,
    required?: string[],
  ): { removedConstraintKeys: string[]; types: TSNode[] } {
    const occurrences: {
      index: number;
      item: SchemaObject | ReferenceObject;
      replaced: boolean;
      type: TSNode;
    }[] = [];

    for (const [index, item] of items.entries()) {
      const itemObserver: TransformObserver = { replaced: false };
      const transformedItem =
        "$ref" in item
          ? item
          : {
              ...item,
              required: [...(required ?? []), ...(item.required ?? [])],
            };
      const type = transformSchemaObjectObserved(transformedItem, options, false, itemObserver, true, indent);
      occurrences.push({
        index,
        item,
        replaced: itemObserver.replaced,
        type,
      });
    }

    // A replacement is authoritative for that occurrence. Only untouched constraint members may be lowered into
    // the aggregate helper without discarding the callback's result.
    const removedConstraintKeys = occurrences.flatMap(({ index, replaced }) =>
      !replaced && candidateConstraints.has(index) ? (candidateConstraints.get(index) ?? []) : [],
    );
    const removedConstraintIndexes = new Set(
      occurrences.flatMap(({ index, replaced }) => (!replaced && candidateConstraints.has(index) ? [index] : [])),
    );
    const hasRemovedConstraint = removedConstraintIndexes.size > 0;
    const types = occurrences.flatMap(({ index, item, type }) => {
      if (removedConstraintIndexes.has(index)) {
        return [];
      }

      let itemType = type;
      // If no typed member was removed, preserve ordinary parent-required ref lowering without re-running hooks.
      if (!hasRemovedConstraint && "$ref" in item) {
        itemType = applyRequiredToRef(item, itemType, required);
      }
      const discriminator =
        ("$ref" in item && options.ctx.discriminators.objects[item.$ref]) || (item as any).discriminator;
      return [discriminator ? tsOmit(itemType, [discriminator.propertyName]) : itemType];
    });

    return { removedConstraintKeys: [...new Set(removedConstraintKeys)], types };
  }

  function applyRequiredToRef(
    item: ReferenceObject,
    itemType: TSNode,
    required?: string[],
    discoverRequiredKeys = false,
    constraintRequiredKeys = new Set<string>(),
  ): TSNode {
    const resolved = options.ctx.resolve<SchemaObject>(item.$ref);
    const discriminator = options.ctx.discriminators.objects[item.$ref];
    const refHandled = options.ctx.discriminators.refsHandled.includes(item.$ref);
    if (!resolved || typeof resolved !== "object") {
      return itemType;
    }

    const candidateRequired = refHandled
      ? (required ?? []).filter((key) => constraintRequiredKeys.has(key) && key !== discriminator?.propertyName)
      : (required ?? []);
    const validRequired = discoverRequiredKeys
      ? candidateRequired.filter((key) => collectSchemaObjectPropertyNames(resolved).has(key))
      : "properties" in resolved
        ? candidateRequired.filter((key) => !!resolved.properties?.[key])
        : [];
    return validRequired.length ? tsWithRequired(itemType, validRequired, options.ctx.injectFooter) : itemType;
  }

  // compile final type
  let finalType: TSNode | undefined;
  const translatedRequiredConstraintItems = new Set<SchemaObject | ReferenceObject>();
  const constraintRequiredKeys: string[] = [];
  let callbackTypedConstraintItems: Map<number, string[]> | undefined;
  let callbackParentRequiredKeys: string[] = [];
  const hasTransformCallbacks = !!options.ctx.transform || !!options.ctx.postTransform;
  // Hooks and filtering can replace, rename, or remove generated keys. Compositions and early-return
  // schemas can produce unions/literals instead of objects. In either case raw-key inference is unsafe,
  // so retain the original allOf member and its existing transformation semantics.
  const canTranslateRequiredConstraints =
    !options.ctx.transformProperty && !options.ctx.excludeDeprecated && !hasUnsafeRequiredComposition(schemaObject);
  if (canTranslateRequiredConstraints) {
    const requiredConstraintItems = (schemaObject.allOf ?? []).flatMap((item, index) => {
      const required = getRequiredConstraintKeys(item);
      return required ? [{ index, item, required, typed: "type" in item }] : [];
    });
    const requiredConstraintSchemas = new Set(requiredConstraintItems.map(({ item }) => item));
    const knownKeys = collectSchemaObjectPropertyNames(schemaObject);
    const hasRetainedAllOfObjectAssertion = (schemaObject.allOf ?? []).some(
      (item) => !requiredConstraintSchemas.has(item) && hasExplicitNonNullableObjectType(item),
    );
    // Synthetic object branches created while expanding a type array cannot prove that the original schema was
    // object-only. allowCoreObjectAssertion is false for those recursive transformations.
    const hasCallbackRetainedObjectAssertion =
      (allowCoreObjectAssertion && schemaObject.type === "object") || hasRetainedAllOfObjectAssertion;
    if (hasTransformCallbacks) {
      // Symbolic refs resolve against their final component declarations, so callback mode needs no outcome cache.
      const eligibleTypedConstraints = requiredConstraintItems
        .filter(
          ({ required, typed }) =>
            typed && hasCallbackRetainedObjectAssertion && required.every((key) => knownKeys.has(key)),
        )
        .map(({ index, required }) => [index, required] as const);
      if (eligibleTypedConstraints.length) {
        callbackTypedConstraintItems = new Map(eligibleTypedConstraints);
        // Parent required names are independent assertions and need not appear in raw properties.
        // The callback-only helper can represent missing final keys as required unknown.
        callbackParentRequiredKeys = schemaObject.required ?? [];
      }
    }
    for (const { item, required } of requiredConstraintItems) {
      // Removing the member is safe only when every assertion can be represented. A typed constraint
      // also needs another retained object assertion; otherwise removing type: object widens the schema.
      if (!required.every((key) => knownKeys.has(key)) || ("type" in item && !hasRetainedAllOfObjectAssertion)) {
        continue;
      }
      if (!hasTransformCallbacks) {
        translatedRequiredConstraintItems.add(item);
        constraintRequiredKeys.push(...required);
      }
    }
  }
  const combinedRequired = constraintRequiredKeys.length
    ? [...new Set([...(schemaObject.required ?? []), ...constraintRequiredKeys])]
    : schemaObject.required;

  // No-callback translation uses existing core/inline/ref handling, where raw known-key filtering is sufficient.
  // Callback mode instead observes every occurrence and wraps the completed retained aggregate once.
  // core + allOf: intersect
  const coreObjectType = transformSchemaObjectCore(
    constraintRequiredKeys.length ? { ...schemaObject, required: combinedRequired } : schemaObject,
    options,
    indent,
    observer,
  );
  const callbackAllOf = callbackTypedConstraintItems
    ? collectCallbackAwareAllOfCompositions(
        schemaObject.allOf ?? [],
        callbackTypedConstraintItems,
        schemaObject.required,
      )
    : undefined;
  const allOfType =
    callbackAllOf?.types ??
    collectAllOfCompositions(
      schemaObject.allOf ?? [],
      combinedRequired,
      translatedRequiredConstraintItems,
      constraintRequiredKeys.length > 0,
      new Set(constraintRequiredKeys),
    );
  if (coreObjectType || allOfType.length) {
    const allOf: TSNode | undefined = allOfType.length ? tsIntersection(allOfType) : undefined;
    finalType = tsIntersection([...(coreObjectType ? [coreObjectType] : []), ...(allOf ? [allOf] : [])]);
    if (callbackAllOf?.removedConstraintKeys.length) {
      // Exact type: object constraints reject non-object callback output, unlike ordinary JSON Schema required.
      // Keep that behavior separate from the public legacy WithRequired helper.
      finalType = tsWithRequiredObject(
        finalType,
        [...new Set([...callbackParentRequiredKeys, ...callbackAllOf.removedConstraintKeys])],
        options.ctx.injectFooter,
        shouldInlineWithRequiredObject(options),
      );
    }
  }
  // anyOf: union
  // (note: this may seem counterintuitive, but as TypeScript’s unions are not true XORs, they mimic behavior closer to anyOf than oneOf)
  const anyOfType = collectUnionCompositions(schemaObject.anyOf ?? [], "anyOf");
  if (anyOfType.length) {
    finalType = tsUnion([...(finalType ? [finalType] : []), ...anyOfType]);
  }
  // oneOf: union (within intersection with other types, if any)
  const oneOfType = collectUnionCompositions(
    schemaObject.oneOf ||
      ("type" in schemaObject &&
        schemaObject.type === "object" &&
        (schemaObject.enum as (SchemaObject | ReferenceObject)[])) ||
      [],
    "oneOf",
  );
  if (oneOfType.length) {
    // note: oneOf is the only type that may include primitives
    if (oneOfType.every(tsIsPrimitive)) {
      finalType = tsUnion([...(finalType ? [finalType] : []), ...oneOfType]);
    } else {
      finalType = tsIntersection([...(finalType ? [finalType] : []), tsUnion(oneOfType)]);
    }
  }

  // When no final type can be generated, fall back to unknown type (or related variants)
  if (!finalType) {
    if ("type" in schemaObject) {
      finalType = tsRecord(STRING, options.ctx.emptyObjectsUnknown ? UNKNOWN : NEVER);
    } else {
      finalType = UNKNOWN;
    }
  }

  if (finalType !== UNKNOWN && schemaObject.nullable) {
    finalType = tsNullable([finalType]);
  }

  return finalType;

  function collectSchemaObjectPropertyNames(
    schema: SchemaObject | ReferenceObject,
    propertyNames = new Set<string>(),
    refsSeen = new Set<string>(),
  ): Set<string> {
    // Required properties may be declared behind nested allOf refs, so follow them recursively while
    // guarding cycles. Explicit primitives ignore properties during transformation and cannot supply keys.
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return propertyNames;
    }
    if ("$ref" in schema) {
      if (refsSeen.has(schema.$ref)) {
        return propertyNames;
      }
      refsSeen.add(schema.$ref);
      const resolved = options.ctx.resolve<SchemaObject | ReferenceObject>(schema.$ref);
      if (resolved) {
        collectSchemaObjectPropertyNames(resolved, propertyNames, refsSeen);
      }
      return propertyNames;
    }
    if ("properties" in schema && schema.properties && (!("type" in schema) || schema.type === "object")) {
      for (const key of Object.keys(schema.properties)) {
        propertyNames.add(key);
      }
    }
    for (const item of schema.allOf ?? []) {
      collectSchemaObjectPropertyNames(item, propertyNames, refsSeen);
    }
    return propertyNames;
  }

  function hasExplicitNonNullableObjectType(
    schema: SchemaObject | ReferenceObject,
    refsSeen = new Set<string>(),
  ): boolean {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return false;
    }
    if ("$ref" in schema) {
      if (refsSeen.has(schema.$ref)) {
        return false;
      }
      refsSeen.add(schema.$ref);
      const resolved = options.ctx.resolve<SchemaObject | ReferenceObject>(schema.$ref);
      return resolved ? hasExplicitNonNullableObjectType(resolved, refsSeen) : false;
    }
    if (schema.nullable || (Array.isArray(schema.type) && schema.type.includes("null"))) {
      return false;
    }
    if (schema.type === "object") {
      return true;
    }
    return (schema.allOf ?? []).some((item) => hasExplicitNonNullableObjectType(item, refsSeen));
  }

  function hasUnsafeRequiredComposition(schema: SchemaObject | ReferenceObject, refsSeen = new Set<string>()): boolean {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return false;
    }
    if ("$ref" in schema) {
      if (refsSeen.has(schema.$ref)) {
        return false;
      }
      refsSeen.add(schema.$ref);
      const resolved = options.ctx.resolve<SchemaObject | ReferenceObject>(schema.$ref);
      return resolved ? hasUnsafeRequiredComposition(resolved, refsSeen) : false;
    }
    // These paths return literals/unions or apply nullable/composition semantics before object properties
    // can be trusted. Raw property names therefore cannot safely parameterize WithRequired<T, K>.
    if (
      (schema.const !== null && schema.const !== undefined) ||
      (Array.isArray(schema.enum) && (!("type" in schema) || schema.type !== "object") && !("properties" in schema)) ||
      schema.nullable ||
      Array.isArray(schema.type) ||
      schema.anyOf ||
      schema.oneOf ||
      (schema.type === "object" && schema.enum)
    ) {
      return true;
    }
    return (schema.allOf ?? []).some((item) => hasUnsafeRequiredComposition(item, refsSeen));
  }
}

function getRequiredConstraintKeys(schema: SchemaObject | ReferenceObject): string[] | undefined {
  // Translate only exact { required } or { type: "object", required } members. Any other keyword may
  // carry validation or annotation semantics that cannot be preserved after removing the allOf member.
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    "$ref" in schema ||
    ("type" in schema && schema.type !== "object") ||
    !Array.isArray(schema.required) ||
    schema.required.length === 0 ||
    !schema.required.every((key) => typeof key === "string") ||
    Object.keys(schema).some((key) => key !== "type" && key !== "required")
  ) {
    return undefined;
  }
  return schema.required;
}

function shouldInlineWithRequiredObject(options: TransformNodeOptions): boolean {
  // Generated enums/root aliases and arbitrary injected source may bind the helper
  // name. Inline when we cannot prove it is free, avoiding a runtime source parser.
  if (options.ctx.enum || options.ctx.rootTypesNoSchemaPrefix || options.ctx.inject) {
    return true;
  }
  return options.ctx.injectFooter.some((node) => typeof node === "string" && !isWithRequiredObjectHelper(node));
}

/**
 * Check if the given OAPI enum should be transformed to a TypeScript enum
 */
function shouldTransformToTsEnum(options: TransformNodeOptions, schemaObject: SchemaObject): boolean {
  // Enum conversion not enabled or no enum present
  if (!options.ctx.enum || !schemaObject.enum) {
    return false;
  }

  // Enum must have string, number or null values
  if (!schemaObject.enum.every((v) => ["string", "number", null].includes(typeof v))) {
    return false;
  }

  // If conditionalEnums is enabled, only convert if x-enum-* metadata is present
  if (options.ctx.conditionalEnums) {
    const hasEnumMetadata =
      Array.isArray(schemaObject["x-enum-varnames"]) ||
      Array.isArray(schemaObject["x-enumNames"]) ||
      Array.isArray(schemaObject["x-enum-descriptions"]) ||
      Array.isArray(schemaObject["x-enumDescriptions"]);
    if (!hasEnumMetadata) {
      return false;
    }
  }

  return true;
}

/**
 * Handle SchemaObject minus composition (anyOf/allOf/oneOf)
 */
function transformSchemaObjectCore(
  schemaObject: SchemaObject,
  options: TransformNodeOptions,
  indent = "",
  observer?: TransformObserver,
): TSNode | undefined {
  if ("type" in schemaObject && schemaObject.type) {
    if (typeof options.ctx.transform === "function") {
      const result = options.ctx.transform(schemaObject, options);
      if (result) {
        if (observer) {
          observer.replaced = true;
        }
        if (typeof result === "object" && "schema" in result) {
          if (result.questionToken) {
            return tsUnion([result.schema, UNDEFINED]);
          }
          return result.schema;
        }
        return result as TSNode;
      }
    }

    // primitives
    // type: null
    if (schemaObject.type === "null") {
      return NULL;
    }
    // type: string
    if (schemaObject.type === "string") {
      return STRING;
    }
    // type: number / type: integer
    if (schemaObject.type === "number" || schemaObject.type === "integer") {
      return NUMBER;
    }
    // type: boolean
    if (schemaObject.type === "boolean") {
      return BOOLEAN;
    }

    // type: array (with support for tuples)
    if (schemaObject.type === "array") {
      /** Build the array element type at `elementIndent` */
      const buildItemType = (elementIndent: string): TSNode => {
        // tuple type
        if (schemaObject.prefixItems || Array.isArray(schemaObject.items)) {
          const prefixItems = schemaObject.prefixItems ?? (schemaObject.items as (SchemaObject | ReferenceObject)[]);
          return tupleType(
            prefixItems.map((item) => transformSchemaObject(item, options, false, `${elementIndent}${INDENT}`)),
            elementIndent,
          );
        }
        // standard array type
        if (schemaObject.items) {
          return transformSchemaObject(schemaObject.items, options, false, elementIndent);
        }
        return UNKNOWN;
      };

      const isTupleShape = Boolean(schemaObject.prefixItems || Array.isArray(schemaObject.items));
      const min: number =
        typeof schemaObject.minItems === "number" && schemaObject.minItems >= 0 ? schemaObject.minItems : 0;
      const max: number | undefined =
        typeof schemaObject.maxItems === "number" && schemaObject.maxItems >= 0 && min <= schemaObject.maxItems
          ? schemaObject.maxItems
          : undefined;
      const estimateCodeSize = typeof max !== "number" ? min : (max * (max + 1) - min * (min - 1)) / 2;
      if (
        options.ctx.arrayLength &&
        (min !== 0 || max !== undefined) &&
        estimateCodeSize < 30 // "30" is an arbitrary number but roughly around when TS starts to struggle with tuple inference in practice
      ) {
        // tuple elements live one level deeper than the tuple itself
        const elementIndent = `${indent}${INDENT}`;
        const itemType = buildItemType(elementIndent);
        if (min === max) {
          const elements: TSNode[] = [];
          for (let i = 0; i < min; i++) {
            elements.push(itemType);
          }
          return tsUnion([tupleType(elements, indent)]);
        }
        if ((schemaObject.maxItems as number) > 0) {
          // if maxItems is set, then return a union of all permutations of possible tuple types
          const members: TSNode[] = [];
          // populate 1 short of min …
          for (let i = 0; i <= (max ?? 0) - min; i++) {
            const elements: TSNode[] = [];
            for (let j = min; j < i + min; j++) {
              elements.push(itemType);
            }
            members.push(tupleType(elements, indent));
          }
          return tsUnion(members);
        }
        // if maxItems not set, then return a simple tuple type the length of `min`
        const elements: TSNode[] = [];
        for (let i = 0; i < min; i++) {
          elements.push(itemType);
        }
        elements.push(`...${tsArray(itemType)}`);
        return tupleType(elements, indent);
      }

      const itemType = buildItemType(indent);
      // Only prefixItems/legacy tuple items describe the whole array. A schema
      // in `items` always describes one element, even when it emits an array,
      // tuple, or union. Do not infer that distinction from the rendered text.
      const finalType = isTupleShape ? itemType : tsArray(itemType);

      return options.ctx.immutable ? `readonly ${tsParenthesize(finalType)}` : finalType;
    }

    // polymorphic, or 3.1 nullable
    if (Array.isArray(schemaObject.type) && !Array.isArray(schemaObject)) {
      // skip any primitive types that appear in oneOf as well
      const uniqueTypes: TSNode[] = [];
      if (Array.isArray(schemaObject.oneOf)) {
        for (const t of schemaObject.type) {
          if (
            (t === "boolean" || t === "string" || t === "number" || t === "integer" || t === "null") &&
            schemaObject.oneOf.find((o) => typeof o === "object" && "type" in o && o.type === t)
          ) {
            continue;
          }
          uniqueTypes.push(
            t === "null" || t === null
              ? NULL
              : transformSchemaObjectObserved(
                  { ...schemaObject, type: t, oneOf: undefined } as SchemaObject, // don’t stack oneOf transforms
                  options,
                  false,
                  undefined,
                  false,
                  indent,
                ),
          );
        }
      } else {
        for (const t of schemaObject.type) {
          if (t === "null" || t === null) {
            uniqueTypes.push(NULL);
          } else {
            uniqueTypes.push(
              transformSchemaObjectObserved(
                { ...schemaObject, type: t } as SchemaObject,
                options,
                false,
                undefined,
                false,
                indent,
              ),
            );
          }
        }
      }
      return tsUnion(uniqueTypes);
    }
  }

  // type: object
  const memberIndent = `${indent}${INDENT}`;
  const coreObjectType: TSNode[] = [];

  // discriminators: explicit mapping on schema object
  for (const k of ["allOf", "anyOf"] as const) {
    if (!schemaObject[k]) {
      continue;
    }
    // for all magic inheritance, we will have already gathered it into
    // ctx.discriminators. But stop objects from referencing their own
    // discriminator meant for children (!schemaObject.discriminator)
    // and don't add discriminator properties if we already added/patched
    // them (options.ctx.discriminators.refsHandled.includes(options.path!).
    const discriminator =
      !schemaObject.discriminator &&
      !options.ctx.discriminators.refsHandled.includes(options.path ?? "") &&
      options.ctx.discriminators.objects[options.path ?? ""];
    if (discriminator) {
      coreObjectType.unshift(
        createDiscriminatorProperty(discriminator, {
          path: options.path ?? "",
          readonly: options.ctx.immutable,
          indent: memberIndent,
        }),
      );
      break;
    }
  }

  if (
    ("properties" in schemaObject && schemaObject.properties && Object.keys(schemaObject.properties).length) ||
    ("additionalProperties" in schemaObject && schemaObject.additionalProperties) ||
    ("patternProperties" in schemaObject && schemaObject.patternProperties) ||
    ("$defs" in schemaObject && schemaObject.$defs)
  ) {
    // properties
    if ("properties" in schemaObject && schemaObject.properties && Object.keys(schemaObject?.properties).length) {
      for (const [k, v] of getEntries(schemaObject.properties ?? {}, options.ctx)) {
        if ((typeof v !== "object" && typeof v !== "boolean") || Array.isArray(v)) {
          throw new Error(
            `${options.path}: invalid property ${k}. Expected Schema Object or boolean, got ${
              Array.isArray(v) ? "Array" : typeof v
            }`,
          );
        }

        const { $ref, readOnly, writeOnly, hasDefault } =
          typeof v === "object"
            ? {
                $ref: "$ref" in v && v.$ref,
                readOnly: "readOnly" in v && v.readOnly,
                writeOnly: "writeOnly" in v && v.writeOnly,
                hasDefault: "default" in v && v.default !== undefined,
              }
            : {};

        // handle excludeDeprecated option
        if (options.ctx.excludeDeprecated) {
          const resolved = $ref ? options.ctx.resolve<SchemaObject>($ref) : v;
          if ((resolved as SchemaObject)?.deprecated) {
            continue;
          }
        }
        let optional = !(
          (
            schemaObject.required?.includes(k) ||
            (schemaObject.required === undefined && options.ctx.propertiesRequiredByDefault) ||
            (hasDefault &&
              options.ctx.defaultNonNullable &&
              !options.path?.includes("parameters") &&
              !options.path?.includes("requestBody") &&
              !options.path?.includes("requestBodies"))
          ) // can’t be required, even with defaults
        );
        let type = $ref
          ? oapiRef($ref, undefined, { indent: memberIndent })
          : transformSchemaObject(
              v,
              {
                ...options,
                path: createRef([options.path, k]),
              },
              false,
              memberIndent,
            );

        if (typeof options.ctx.transform === "function") {
          const result = options.ctx.transform(v as SchemaObject, options);
          if (result) {
            if (typeof result === "object" && "schema" in result) {
              type = result.schema;
              optional = result.questionToken ? true : optional;
            } else {
              type = result as TSNode;
            }
          }
        }

        type = wrapWithReadWriteMarker(type, !!readOnly, !!writeOnly, options.ctx);

        const propertyLike: PropertySignatureLike = {
          name: tsPropertyIndex(k),
          optional,
          type,
          readonly: options.ctx.immutable || (!options.ctx.readWriteMarkers && !!readOnly),
          indent: memberIndent,
        };

        // Apply transformProperty hook if available
        let finalProperty = propertyLike;
        if (typeof options.ctx.transformProperty === "function") {
          const result = options.ctx.transformProperty(propertyLike, v as SchemaObject, {
            ...options,
            path: createRef([options.path, k]),
          });
          if (result) {
            finalProperty = result;
          }
        }

        coreObjectType.push(
          propertySignature({
            name: finalProperty.name,
            type: finalProperty.type,
            optional: finalProperty.optional,
            /* modifiers     */ readonly: finalProperty.readonly,
            comment: `${finalProperty.comment ?? ""}${addJSDocComment(v, memberIndent)}`,
            indent: memberIndent,
          }),
        );
      }
    }

    // $defs
    if ("$defs" in schemaObject && typeof schemaObject.$defs === "object" && Object.keys(schemaObject.$defs).length) {
      const defsIndent = `${memberIndent}${INDENT}`;
      const defKeys: TSNode[] = [];
      for (const [k, v] of Object.entries(schemaObject.$defs)) {
        const defReadOnly = "readOnly" in v && !!v.readOnly;
        const defWriteOnly = "writeOnly" in v && !!v.writeOnly;
        const defType = wrapWithReadWriteMarker(
          transformSchemaObject(v, { ...options, path: createRef([options.path, "$defs", k]) }, false, defsIndent),
          defReadOnly,
          defWriteOnly,
          options.ctx,
        );

        const propertyLike: PropertySignatureLike = {
          name: tsPropertyIndex(k),
          optional: false,
          type: defType,
          readonly: options.ctx.immutable || (!options.ctx.readWriteMarkers && defReadOnly),
          indent: defsIndent,
        };

        // Apply transformProperty hook if available
        let finalProperty = propertyLike;
        if (typeof options.ctx.transformProperty === "function") {
          const result = options.ctx.transformProperty(propertyLike, v as SchemaObject, {
            ...options,
            path: createRef([options.path, "$defs", k]),
          });
          if (result) {
            finalProperty = result;
          }
        }

        defKeys.push(
          propertySignature({
            name: finalProperty.name,
            type: finalProperty.type,
            optional: finalProperty.optional,
            /* modifiers    */ readonly: finalProperty.readonly,
            comment: `${finalProperty.comment ?? ""}${addJSDocComment(v, defsIndent)}`,
            indent: defsIndent,
          }),
        );
      }
      coreObjectType.push(
        propertySignature({
          /* name          */ name: tsPropertyIndex("$defs"),
          /* type          */ type: typeLiteral(defKeys, memberIndent),
          indent: memberIndent,
        }),
      );
    }

    // additionalProperties / patternProperties
    const hasExplicitAdditionalProperties =
      typeof schemaObject.additionalProperties === "object" && Object.keys(schemaObject.additionalProperties).length;
    const hasImplicitAdditionalProperties =
      schemaObject.additionalProperties === true ||
      (typeof schemaObject.additionalProperties === "object" &&
        Object.keys(schemaObject.additionalProperties).length === 0);
    const patternProperties = hasKey(schemaObject, "patternProperties") ? schemaObject.patternProperties : undefined;
    const hasExplicitPatternProperties =
      typeof patternProperties === "object" && patternProperties !== null && Object.keys(patternProperties).length > 0;
    const stringIndexTypes = [];
    if (hasExplicitAdditionalProperties) {
      stringIndexTypes.push(
        transformSchemaObject(schemaObject.additionalProperties as SchemaObject, options, true, memberIndent),
      );
    }
    if (hasImplicitAdditionalProperties || (!schemaObject.additionalProperties && options.ctx.additionalProperties)) {
      stringIndexTypes.push(UNKNOWN);
    }
    if (hasExplicitPatternProperties && patternProperties && typeof patternProperties === "object") {
      for (const [_, v] of getEntries(
        patternProperties as Record<string, SchemaObject | ReferenceObject>,
        options.ctx,
      )) {
        stringIndexTypes.push(transformSchemaObject(v, options, false, memberIndent));
      }
    }

    if (stringIndexTypes.length === 0) {
      return coreObjectType.length ? typeLiteral(coreObjectType, indent) : undefined;
    }

    const stringIndexType = tsUnion(stringIndexTypes);

    return tsIntersection([
      ...(coreObjectType.length ? [typeLiteral(coreObjectType, indent)] : []),
      typeLiteral(
        [
          indexSignature({
            /* modifiers  */ readonly: options.ctx.immutable,
            /* parameters */ keyName: "key",
            /* type       */ valueType: stringIndexType,
            indent: memberIndent,
          }),
        ],
        indent,
      ),
    ]);
  }

  return coreObjectType.length ? typeLiteral(coreObjectType, indent) : undefined;
}

/**
 * Check if an object has a key
 * @param possibleObject - The object to check
 * @param key - The key to check for
 * @returns True if the object has the key, false otherwise
 */
function hasKey<K extends string>(possibleObject: unknown, key: K): possibleObject is { [key in K]: unknown } {
  return typeof possibleObject === "object" && possibleObject !== null && key in possibleObject;
}

function applyAdditionalPropertiesToEnum(
  hasAdditionalProperties: boolean,
  unionType: TSNode,
  schemaObject: SchemaObject,
): TSNode {
  // If additionalProperties is true, add (string & {}) to the union
  if (hasAdditionalProperties && schemaObject.type === "string") {
    const stringAndEmptyObject = tsIntersection([STRING, "{}"]);
    return tsUnion([unionType, stringAndEmptyObject]);
  }
  return unionType;
}

/** Wrap type with $Read or $Write marker when readWriteMarkers flag is enabled */
function wrapWithReadWriteMarker(
  type: TSNode,
  readOnly: boolean,
  writeOnly: boolean,
  ctx: { readWriteMarkers: boolean },
): TSNode {
  if (!ctx.readWriteMarkers || (readOnly && writeOnly)) {
    return type;
  }
  if (readOnly) {
    return `$Read<${type}>`;
  }
  if (writeOnly) {
    return `$Write<${type}>`;
  }
  return type;
}
