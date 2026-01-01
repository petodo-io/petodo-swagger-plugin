// JSON validation plugin for Swagger UI
(function () {
  "use strict";

  // Storage for textarea handlers
  const textareaHandlers = new WeakMap();
  // Storage for overlay elements
  const textareaOverlays = new WeakMap();
  // Cache for OpenAPI specification
  let openApiSpecCache = null;
  let openApiSpecPromise = null;

  function isRequestBodyElement(element, operationElement) {
    if (!element || !operationElement) return false;

    // Check that element is not in responses section
    const responsesWrapper =
      operationElement.querySelector(".responses-wrapper");
    if (responsesWrapper && responsesWrapper.contains(element)) {
      return false;
    }

    // Check that element is in request body section
    const requestBodySection = element.closest(
      ".opblock-section-request-body, .request-body, .body-param"
    );
    if (requestBodySection) {
      return true;
    }

    // Check that element is before responses
    if (responsesWrapper) {
      const allElements = Array.from(operationElement.querySelectorAll("*"));
      const elementIndex = allElements.indexOf(element);
      const responsesIndex = allElements.indexOf(responsesWrapper);
      if (elementIndex !== -1 && responsesIndex !== -1) {
        return elementIndex < responsesIndex;
      }
    }

    return false;
  }

  function validateJSON(text) {
    if (!text || !text.trim()) {
      return {
        valid: true,
        error: null,
        position: null,
        line: null,
        column: null,
      };
    }

    try {
      JSON.parse(text);
      return {
        valid: true,
        error: null,
        position: null,
        line: null,
        column: null,
      };
    } catch (e) {
      // Try to extract error position from message
      let position = null;
      let line = null;
      let column = null;

      const match = e.message.match(/position (\d+)/);
      if (match) {
        position = parseInt(match[1], 10);
        // Calculate line and column
        const textBeforeError = text.substring(0, position);
        const lines = textBeforeError.split("\n");
        line = lines.length;
        column = lines[lines.length - 1].length + 1;
      }

      return {
        valid: false,
        error: e.message,
        position: position,
        line: line,
        column: column,
      };
    }
  }

  function findErrorRanges(text, errorPosition) {
    if (
      errorPosition === null ||
      errorPosition === undefined ||
      errorPosition < 0 ||
      errorPosition >= text.length
    ) {
      return [];
    }

    // Find start and end of problematic token
    let start = errorPosition;
    let end = errorPosition;

    // If position points to whitespace or newline, find nearest token
    if (/\s/.test(text[errorPosition])) {
      // Search for token on the left
      let leftPos = errorPosition;
      while (leftPos > 0 && /\s/.test(text[leftPos - 1])) {
        leftPos--;
      }
      // Search for token on the right
      let rightPos = errorPosition;
      while (rightPos < text.length && /\s/.test(text[rightPos])) {
        rightPos++;
      }

      // Choose nearest token
      if (leftPos > 0 && !/[{\[}\],:]/.test(text[leftPos - 1])) {
        start = leftPos;
        end = leftPos;
      } else if (rightPos < text.length && !/[{\[}\],:]/.test(text[rightPos])) {
        start = rightPos;
        end = rightPos;
      } else {
        // If token not found, highlight current position
        return [
          {
            start: errorPosition,
            end: Math.min(errorPosition + 1, text.length),
          },
        ];
      }
    }

    // Find token start (search backwards until whitespace, comma, bracket, etc.)
    while (start > 0 && !/[{\[}\],:\s\n\r\t]/.test(text[start - 1])) {
      start--;
    }

    // Find token end
    while (end < text.length && !/[{\[}\],:\s\n\r\t]/.test(text[end])) {
      end++;
    }

    // If token not found, highlight at least one character
    if (start === end) {
      end = Math.min(start + 1, text.length);
    }

    return [{ start: start, end: end }];
  }

  /**
   * Resolves $ref references in schema
   */
  function resolveSchemaRef(ref, spec) {
    if (!ref || typeof ref !== "string") {
      return null;
    }

    if (ref.startsWith("#/components/schemas/")) {
      const schemaName = ref.replace("#/components/schemas/", "");
      if (spec.components && spec.components.schemas) {
        return spec.components.schemas[schemaName] || null;
      }
    } else if (ref.startsWith("#/definitions/")) {
      // OpenAPI 2.0 uses definitions instead of components/schemas
      const schemaName = ref.replace("#/definitions/", "");
      if (spec.definitions) {
        return spec.definitions[schemaName] || null;
      }
    } else if (ref.startsWith("#/components/requestBodies/")) {
      // Reference to request body component
      const bodyName = ref.replace("#/components/requestBodies/", "");
      if (spec.components && spec.components.requestBodies) {
        const requestBody = spec.components.requestBodies[bodyName];
        if (requestBody && requestBody.content) {
          const jsonContent =
            requestBody.content["application/json"] ||
            requestBody.content["application/*"] ||
            requestBody.content["*/*"];
          return jsonContent ? jsonContent.schema : null;
        }
      }
    }

    return null;
  }

  /**
   * Recursively resolves all $ref in schema
   */
  function resolveSchema(schema, spec, visited = new Set()) {
    if (!schema || typeof schema !== "object") {
      return schema;
    }

    // Prevent circular references
    const schemaKey = JSON.stringify(schema);
    if (visited.has(schemaKey)) {
      return schema;
    }
    visited.add(schemaKey);

    // If schema has $ref, resolve it
    if (schema.$ref) {
      const resolved = resolveSchemaRef(schema.$ref, spec);
      if (resolved) {
        // Merge resolved schema with current schema (keep other properties)
        const merged = { ...resolved, ...schema };
        delete merged.$ref;
        return resolveSchema(merged, spec, visited);
      }
    }

    // Recursively resolve nested schemas
    if (schema.properties) {
      const resolvedProperties = {};
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        resolvedProperties[key] = resolveSchema(propSchema, spec, visited);
      }
      schema = { ...schema, properties: resolvedProperties };
    }

    if (schema.items) {
      schema = { ...schema, items: resolveSchema(schema.items, spec, visited) };
    }

    if (schema.allOf && Array.isArray(schema.allOf)) {
      schema = {
        ...schema,
        allOf: schema.allOf.map((s) => resolveSchema(s, spec, visited)),
      };
    }

    if (schema.oneOf && Array.isArray(schema.oneOf)) {
      schema = {
        ...schema,
        oneOf: schema.oneOf.map((s) => resolveSchema(s, spec, visited)),
      };
    }

    if (schema.anyOf && Array.isArray(schema.anyOf)) {
      schema = {
        ...schema,
        anyOf: schema.anyOf.map((s) => resolveSchema(s, spec, visited)),
      };
    }

    return schema;
  }

  /**
   * Loads OpenAPI specification from openapi.json or swagger.json
   */
  async function loadOpenApiSpec() {
    // Return cached spec if available
    if (openApiSpecCache) {
      return openApiSpecCache;
    }

    // Return existing promise if loading is in progress
    if (openApiSpecPromise) {
      return openApiSpecPromise;
    }

    // Try different possible paths for OpenAPI spec
    const possiblePaths = [
      "openapi.json",
      "swagger.json",
      "/openapi.json",
      "/swagger.json",
      "./openapi.json",
      "./swagger.json",
    ];

    // Also try to get from current page URL
    const currentUrl = new URL(window.location.href);
    const basePath = currentUrl.pathname.substring(
      0,
      currentUrl.pathname.lastIndexOf("/") + 1
    );
    possiblePaths.push(basePath + "openapi.json");
    possiblePaths.push(basePath + "swagger.json");

    // Try to find spec URL from Swagger UI config
    if (window.ui && window.ui.specSelectors) {
      try {
        const url = window.ui.specSelectors.url
          ? window.ui.specSelectors.url()
          : null;
        if (url) {
          possiblePaths.unshift(url); // Add to beginning
        }
      } catch (e) {
        // Ignore
      }
    }

    // Create promise for loading
    openApiSpecPromise = (async () => {
      for (const path of possiblePaths) {
        try {
          const url = new URL(path, window.location.origin);
          const response = await fetch(url.toString(), {
            method: "GET",
            headers: {
              Accept: "application/json",
            },
          });

          if (response.ok) {
            const spec = await response.json();
            openApiSpecCache = spec;
            openApiSpecPromise = null; // Clear promise
            return spec;
          }
        } catch (e) {
          // Try next path
          continue;
        }
      }

      // If all paths failed
      openApiSpecPromise = null;
      console.warn(
        "[JSONValidationPlugin] Failed to load OpenAPI specification from any path"
      );
      return null;
    })();

    return openApiSpecPromise;
  }

  /**
   * Gets request schema for operation element
   */
  async function getRequestSchema(operationElement) {
    try {
      // Load OpenAPI specification
      const spec = await loadOpenApiSpec();
      if (!spec || !spec.paths) {
        return null;
      }

      // Find path and method from DOM
      const pathElement = operationElement.querySelector(
        ".opblock-summary-path"
      );
      const methodElement = operationElement.querySelector(
        ".opblock-summary-method"
      );

      if (!pathElement || !methodElement) {
        return null;
      }

      const path = pathElement.textContent.trim();
      const method = methodElement.textContent.trim().toLowerCase();

      // Find operation in specification
      const pathSpec = spec.paths[path];
      if (!pathSpec || !pathSpec[method]) {
        return null;
      }

      const operation = pathSpec[method];
      if (!operation.requestBody) {
        return null;
      }

      // Handle $ref in requestBody
      let requestBody = operation.requestBody;
      if (requestBody.$ref) {
        const resolved = resolveSchemaRef(requestBody.$ref, spec);
        if (resolved) {
          requestBody = resolved;
        }
      }

      // Get schema from content
      const content = requestBody.content;
      if (!content) {
        return null;
      }

      // Look for application/json or */*
      const jsonContent =
        content["application/json"] ||
        content["application/*"] ||
        content["*/*"];
      if (!jsonContent) {
        return null;
      }

      // Get schema directly or via $ref
      let schema = jsonContent.schema;
      if (!schema && jsonContent.schemaRef) {
        // Try to resolve schema reference
        if (jsonContent.schemaRef.$ref) {
          schema = resolveSchemaRef(jsonContent.schemaRef.$ref, spec);
        } else {
          schema = jsonContent.schemaRef;
        }
      }

      // Resolve all $ref in schema recursively
      if (schema) {
        schema = resolveSchema(schema, spec);
      }

      return schema || null;
    } catch (e) {
      console.warn("[JSONValidationPlugin] Error getting schema:", e);
      return null;
    }
  }

  /**
   * Checks if a value matches the expected schema type
   */
  function isTypeMatch(value, expectedType) {
    if (expectedType === "integer") {
      // For integer type, check if value is a number and is an integer
      return (
        typeof value === "number" &&
        !isNaN(value) &&
        isFinite(value) &&
        Number.isInteger(value)
      );
    }

    if (expectedType === "number") {
      // For number type, check if value is a number (including integers)
      return typeof value === "number" && !isNaN(value) && isFinite(value);
    }

    // For other types, use standard JavaScript type checking
    const actualType = Array.isArray(value)
      ? "array"
      : value === null
      ? "null"
      : typeof value;

    return actualType === expectedType;
  }

  function validateSchema(data, schema) {
    const errors = [];

    if (!schema || typeof schema !== "object") {
      return errors;
    }

    // Check required fields
    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (!(field in data)) {
          errors.push({
            path: field,
            message: `Required field "${field}" is missing`,
          });
        }
      }
    }

    // Check properties
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          const value = data[key];
          const valueType = Array.isArray(value)
            ? "array"
            : value === null
            ? "null"
            : typeof value;

          // Check type
          if (propSchema.type && !isTypeMatch(value, propSchema.type)) {
            // Exception: null can be allowed if nullable: true
            if (!(value === null && propSchema.nullable)) {
              errors.push({
                path: key,
                message: `Field "${key}" must be of type ${propSchema.type}, got ${valueType}`,
              });
            }
          }

          // Recursive check for nested objects
          if (
            propSchema.type === "object" &&
            propSchema.properties &&
            valueType === "object" &&
            value !== null
          ) {
            const nestedErrors = validateSchema(value, propSchema);
            nestedErrors.forEach((error) => {
              errors.push({
                path: `${key}.${error.path}`,
                message: error.message,
              });
            });
          }

          // Check arrays
          if (propSchema.type === "array" && propSchema.items) {
            if (Array.isArray(value)) {
              value.forEach((item, index) => {
                if (propSchema.items.type) {
                  const itemType = Array.isArray(item)
                    ? "array"
                    : item === null
                    ? "null"
                    : typeof item;
                  if (!isTypeMatch(item, propSchema.items.type)) {
                    errors.push({
                      path: `${key}[${index}]`,
                      message: `Array element "${key}[${index}]" must be of type ${propSchema.items.type}, got ${itemType}`,
                    });
                  }
                }
                // Recursive check for objects in array
                if (
                  propSchema.items.type === "object" &&
                  propSchema.items.properties &&
                  itemType === "object" &&
                  item !== null
                ) {
                  const nestedErrors = validateSchema(item, propSchema.items);
                  nestedErrors.forEach((error) => {
                    errors.push({
                      path: `${key}[${index}].${error.path}`,
                      message: error.message,
                    });
                  });
                }
              });
            }
          }
        }
      }
    }

    return errors;
  }

  function createJsonErrorElement(textarea) {
    // Check in wrapper if it exists
    const wrapper = textarea.closest(".json-validation-wrapper");
    const parent = wrapper || textarea.parentElement;

    let errorElement = parent.querySelector(".json-validation-error");

    if (!errorElement) {
      errorElement = document.createElement("div");
      errorElement.className = "json-validation-error";
      parent.appendChild(errorElement);
    }

    return errorElement;
  }

  function createSchemaErrorElement(textarea) {
    // Check in wrapper if it exists
    const wrapper = textarea.closest(".json-validation-wrapper");
    const parent = wrapper || textarea.parentElement;

    let errorElement = parent.querySelector(".json-validation-schema-error");

    if (!errorElement) {
      errorElement = document.createElement("div");
      errorElement.className = "json-validation-schema-error";
      parent.appendChild(errorElement);
    }

    return errorElement;
  }

  function removeErrorElement(textarea) {
    // Check in wrapper if it exists
    const wrapper = textarea.closest(".json-validation-wrapper");
    const parent = wrapper || textarea.parentElement;

    // Remove JSON syntax errors (red)
    const jsonErrorElement = parent.querySelector(".json-validation-error");
    if (jsonErrorElement) {
      jsonErrorElement.remove();
    }

    // Remove schema validation errors (yellow/orange)
    const schemaErrorElement = parent.querySelector(
      ".json-validation-schema-error"
    );
    if (schemaErrorElement) {
      schemaErrorElement.remove();
    }
  }

  function highlightErrors(textarea, errorMessage, errorPosition) {
    if (errorMessage) {
      textarea.classList.add("json-validation-error-input");
    } else {
      textarea.classList.remove("json-validation-error-input");
    }
  }

  /**
   * Finds the position of a field in JSON text by its path
   */
  function findFieldPosition(text, path) {
    try {
      const data = JSON.parse(text);
      const pathParts = path.split(".");
      let current = data;
      let jsonPath = "";

      // Navigate through the path
      for (let i = 0; i < pathParts.length; i++) {
        const part = pathParts[i];
        // Handle array indices like "items[0]"
        const arrayMatch = part.match(/^(.+)\[(\d+)\]$/);
        if (arrayMatch) {
          const fieldName = arrayMatch[1];
          const index = parseInt(arrayMatch[2], 10);
          jsonPath += (jsonPath ? "." : "") + fieldName;
          if (current && typeof current === "object" && fieldName in current) {
            current = current[fieldName];
            if (Array.isArray(current) && current[index] !== undefined) {
              current = current[index];
              jsonPath += `[${index}]`;
            } else {
              return null;
            }
          } else {
            return null;
          }
        } else {
          jsonPath += (jsonPath ? "." : "") + part;
          if (current && typeof current === "object" && part in current) {
            current = current[part];
          } else {
            return null;
          }
        }
      }

      // Now find the position in the text
      // Search for the field name in the JSON string
      const fieldName = pathParts[pathParts.length - 1].replace(/\[\d+\]$/, "");
      const searchPattern = new RegExp(
        `"${fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`,
        "g"
      );
      let match;
      let lastMatch = null;

      // Find all matches and try to determine which one corresponds to our path
      while ((match = searchPattern.exec(text)) !== null) {
        lastMatch = match;
        // Try to verify this is the right field by checking context
        const beforeMatch = text.substring(0, match.index);
        const openBraces = (beforeMatch.match(/{/g) || []).length;
        const closeBraces = (beforeMatch.match(/}/g) || []).length;
        const openBrackets = (beforeMatch.match(/\[/g) || []).length;
        const closeBrackets = (beforeMatch.match(/\]/g) || []).length;

        // Simple heuristic: if nesting matches, it's likely the right field
        if (openBraces - closeBraces >= pathParts.length - 1) {
          // Find the value after the colon
          let valueStart = match.index + match[0].length;
          // Skip whitespace
          while (valueStart < text.length && /\s/.test(text[valueStart])) {
            valueStart++;
          }

          // Find the end of the value
          let valueEnd = valueStart;
          if (text[valueStart] === '"') {
            // String value
            valueEnd = text.indexOf('"', valueStart + 1);
            if (valueEnd !== -1) valueEnd++;
          } else if (text[valueStart] === "{") {
            // Object value
            let depth = 1;
            valueEnd = valueStart + 1;
            while (valueEnd < text.length && depth > 0) {
              if (text[valueEnd] === "{") depth++;
              else if (text[valueEnd] === "}") depth--;
              valueEnd++;
            }
          } else if (text[valueStart] === "[") {
            // Array value
            let depth = 1;
            valueEnd = valueStart + 1;
            while (valueEnd < text.length && depth > 0) {
              if (text[valueEnd] === "[") depth++;
              else if (text[valueEnd] === "]") depth--;
              valueEnd++;
            }
          } else {
            // Number, boolean, null
            while (
              valueEnd < text.length &&
              !/[,\]\}\s]/.test(text[valueEnd])
            ) {
              valueEnd++;
            }
          }

          return {
            start: valueStart,
            end: valueEnd,
          };
        }
      }

      // If we found a match but couldn't verify, use it anyway
      if (lastMatch) {
        let valueStart = lastMatch.index + lastMatch[0].length;
        while (valueStart < text.length && /\s/.test(text[valueStart])) {
          valueStart++;
        }
        let valueEnd = valueStart;
        while (valueEnd < text.length && !/[,\]\}\s]/.test(text[valueEnd])) {
          valueEnd++;
        }
        return { start: valueStart, end: valueEnd };
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  function updateOverlay(textarea, text, errorRanges, schemaErrors, errorType) {
    let overlay = textareaOverlays.get(textarea);
    if (!overlay) {
      return;
    }

    if (!text || !text.trim()) {
      overlay.innerHTML = "";
      return;
    }

    // Determine highlight class based on error type
    const highlightClass =
      errorType === "schema"
        ? "json-validation-schema-highlight"
        : "json-validation-highlight";

    // Create HTML with error highlighting
    let html = "";
    let lastIndex = 0;

    // Combine all error ranges
    const allRanges = [...errorRanges];

    // Add schema error ranges if provided
    if (schemaErrors && schemaErrors.length > 0 && errorType === "schema") {
      for (const error of schemaErrors) {
        const position = findFieldPosition(text, error.path);
        if (position) {
          allRanges.push(position);
        }
      }
    }

    // Sort ranges by position
    allRanges.sort((a, b) => a.start - b.start);

    // Merge overlapping ranges
    const mergedRanges = [];
    for (const range of allRanges) {
      if (mergedRanges.length === 0) {
        mergedRanges.push({ start: range.start, end: range.end });
      } else {
        const last = mergedRanges[mergedRanges.length - 1];
        if (range.start <= last.end) {
          // Overlapping, merge
          last.end = Math.max(last.end, range.end);
        } else {
          // Not overlapping, add new
          mergedRanges.push({ start: range.start, end: range.end });
        }
      }
    }

    // Create HTML with highlighting
    for (const range of mergedRanges) {
      // Add text before error
      if (range.start > lastIndex) {
        const beforeText = escapeHtml(text.substring(lastIndex, range.start));
        html += beforeText;
      }

      // Add highlighted error text
      const errorText = escapeHtml(text.substring(range.start, range.end));
      html += `<span class="${highlightClass}">${errorText}</span>`;

      lastIndex = range.end;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      const afterText = escapeHtml(text.substring(lastIndex));
      html += afterText;
    }

    overlay.innerHTML = html;
  }

  function createOverlay(textarea) {
    // Check if overlay already exists
    if (textareaOverlays.has(textarea)) {
      return;
    }

    // Create wrapper if it doesn't exist
    let wrapper = textarea.parentElement.querySelector(
      ".json-validation-wrapper"
    );
    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.className = "json-validation-wrapper";

      // Insert wrapper before textarea
      textarea.parentElement.insertBefore(wrapper, textarea);
      // Move textarea inside wrapper
      wrapper.appendChild(textarea);
    }

    // Create overlay
    const overlay = document.createElement("div");
    overlay.className = "json-validation-overlay";
    wrapper.appendChild(overlay);

    // Save overlay
    textareaOverlays.set(textarea, overlay);

    // Sync sizes and styles
    syncOverlayStyles(textarea, overlay);

    // Sync scroll
    textarea.addEventListener("scroll", function () {
      overlay.scrollTop = textarea.scrollTop;
      overlay.scrollLeft = textarea.scrollLeft;
    });

    // Sync on resize
    const resizeObserver = new ResizeObserver(function () {
      syncOverlayStyles(textarea, overlay);
    });
    resizeObserver.observe(textarea);
  }

  function syncOverlayStyles(textarea, overlay) {
    overlay.style.width = textarea.offsetWidth + "px";
    overlay.style.height = textarea.offsetHeight + "px";
  }

  function validateTextarea(textarea, operationElement) {
    const text = textarea.value;
    const jsonValidation = validateJSON(text);

    // Remove previous errors
    removeErrorElement(textarea);
    textarea.classList.remove("json-validation-error-input");

    // Create overlay if it doesn't exist
    createOverlay(textarea);
    const overlay = textareaOverlays.get(textarea);

    // If text is empty, don't show errors
    if (!text || !text.trim()) {
      if (overlay) {
        overlay.innerHTML = "";
      }
      return;
    }

    // Check JSON validity
    if (!jsonValidation.valid) {
      highlightErrors(textarea, jsonValidation.error, jsonValidation.position);
      // Remove schema errors if any
      const wrapper = textarea.closest(".json-validation-wrapper");
      const parent = wrapper || textarea.parentElement;
      const schemaErrorElement = parent.querySelector(
        ".json-validation-schema-error"
      );
      if (schemaErrorElement) {
        schemaErrorElement.remove();
      }

      const errorElement = createJsonErrorElement(textarea);
      errorElement.innerHTML = `
        <div class="json-validation-error-message">${escapeHtml(
          jsonValidation.error
        )}</div>
      `;

      // Highlight error in overlay
      if (overlay) {
        const errorRanges = findErrorRanges(text, jsonValidation.position);
        updateOverlay(textarea, text, errorRanges, [], "json");
      }
      return;
    }

    // If JSON is valid, check schema
    try {
      const data = JSON.parse(text);
      getRequestSchema(operationElement)
        .then((schema) => {
          if (schema) {
            const schemaErrors = validateSchema(data, schema);
            if (schemaErrors.length > 0) {
              textarea.classList.add("json-validation-schema-error-input");
              // Remove JSON syntax errors if any (shouldn't be, but just in case)
              const wrapper = textarea.closest(".json-validation-wrapper");
              const parent = wrapper || textarea.parentElement;
              const jsonErrorElement = parent.querySelector(
                ".json-validation-error"
              );
              if (jsonErrorElement) {
                jsonErrorElement.remove();
              }

              const errorElement = createSchemaErrorElement(textarea);
              const errorsHtml = schemaErrors
                .map(
                  (error) =>
                    `<div class="json-validation-error-item">
                      <span class="json-validation-error-path">${escapeHtml(
                        error.path
                      )}:</span>
                      <span class="json-validation-error-text">${escapeHtml(
                        error.message
                      )}</span>
                    </div>`
                )
                .join("");
              errorElement.innerHTML = `
                <div class="json-validation-error-list">${errorsHtml}</div>
              `;

              // Highlight schema errors in overlay
              if (overlay) {
                updateOverlay(textarea, text, [], schemaErrors, "schema");
              }
            } else {
              textarea.classList.remove("json-validation-schema-error-input");
              removeErrorElement(textarea);
              // If everything is valid, clear overlay
              if (overlay) {
                overlay.innerHTML = "";
              }
            }
          } else {
            // No schema available, clear any schema errors
            textarea.classList.remove("json-validation-schema-error-input");
            // Remove schema error element if exists
            const wrapper = textarea.closest(".json-validation-wrapper");
            const parent = wrapper || textarea.parentElement;
            const schemaErrorElement = parent.querySelector(
              ".json-validation-schema-error"
            );
            if (schemaErrorElement) {
              schemaErrorElement.remove();
            }
            // If everything is valid, clear overlay
            if (overlay) {
              overlay.innerHTML = "";
            }
          }
        })
        .catch((e) => {
          console.warn("[JSONValidationPlugin] Error validating schema:", e);
          if (overlay) {
            overlay.innerHTML = "";
          }
        });
    } catch (e) {
      // This shouldn't happen since we already checked JSON
      console.warn("[JSONValidationPlugin] Unexpected error:", e);
      if (overlay) {
        overlay.innerHTML = "";
      }
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function addValidationToTextarea(textarea, operationElement) {
    // Check that this is a request body textarea
    if (!isRequestBodyElement(textarea, operationElement)) {
      return;
    }

    // Check that handler is not already added
    if (textareaHandlers.has(textarea)) {
      return;
    }

    // Add handler with debounce
    let timeoutId = null;
    const handler = function () {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(function () {
        validateTextarea(textarea, operationElement);
      }, 300); // Debounce 300ms
    };

    textarea.addEventListener("input", handler);
    textarea.addEventListener("change", handler);

    // Save handler
    textareaHandlers.set(textarea, handler);

    // Validate immediately if there is content
    if (textarea.value && textarea.value.trim()) {
      validateTextarea(textarea, operationElement);
    }
  }

  function processOperation(operationElement) {
    const textareas = operationElement.querySelectorAll("textarea");
    textareas.forEach(function (textarea) {
      addValidationToTextarea(textarea, operationElement);
    });
  }

  function processOperations() {
    const operations = document.querySelectorAll(".opblock");
    operations.forEach(function (operation) {
      processOperation(operation);
    });
  }

  function init() {
    let observer = null;
    let initTimeout = null;

    function initialize() {
      const swaggerContainer = document.querySelector(".swagger-ui");
      if (!swaggerContainer) {
        return;
      }

      // Process operations
      processOperations();

      // Setup MutationObserver to track dynamic changes
      if (!observer) {
        observer = new MutationObserver(function () {
          clearTimeout(initTimeout);
          initTimeout = setTimeout(processOperations, 100);
        });

        observer.observe(swaggerContainer, {
          childList: true,
          subtree: true,
        });
      }
    }

    function waitForSwaggerUI() {
      const swaggerContainer = document.querySelector(".swagger-ui");
      if (swaggerContainer) {
        setTimeout(initialize, 300);
      } else {
        setTimeout(waitForSwaggerUI, 100);
      }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", waitForSwaggerUI);
    } else {
      waitForSwaggerUI();
    }
  }

  // Export initialization function
  window.JSONValidationPlugin = {
    init: init,
    name: "json-validation",
  };
})();
