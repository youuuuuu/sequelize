const { parseNestedJsonKeySyntax, parseAttributeSyntax } = require('./packages/core/lib/utils/attribute-syntax.js');
console.log(parseNestedJsonKeySyntax('a.b[0].c'));
console.log(parseAttributeSyntax('a.b[0].c'));
