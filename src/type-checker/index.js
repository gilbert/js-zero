/*
 * Implementation of "Compositional Type Checking" by Georgö Érdi
 * Download the whitepaper PDF at http://gergo.erdi.hu/projects/tandoori/
 */
'use strict'

var ESTraverse   = require('estraverse')
var Scope        = require('./scope')
var Errors       = require('./type-errors')

var Env     = require('./environment')
var Typing  = require('./typing')
var t      = require('../types')

var util = require('util')
var inspect = function (obj) { return util.inspect(obj, { showHidden: false, depth: null }) }
var fail = require('./assert').fail

var utilLib = require('../util')
var flattenOneLevel = utilLib.flattenOneLevel
var pushAll         = utilLib.pushAll
var extend          = utilLib.extend
var objMap          = utilLib.objMap
var objFilter       = utilLib.objFilter
var findIndex       = utilLib.findIndex
var identity        = (x) => x


exports.typeCheck = function (ast, scopes) {

  var env = Env(null)

  try {
    buildEnv(env, ast)
    log("\n----\nGOT environment:", inspect(env))
    return { env: env, typeErrors: [] }
  }
  catch (err) {
    if (err instanceof Errors.TypeError) {
      // Eventually we want to be able to return multiple type errors in one go
      return { env: env, typeErrors: [err] }
    }
    else {
      throw err
    }
  }
}


function buildEnv (env, node) {

  switch(node.type) {

    //
    // Transient nodes
    //
    case 'Program':
    case 'BlockStatement':
      // Every statement can potentially add to the environment (e.g. `let` statements).
      node.body.forEach( n => buildEnv(env, n) )
      return env

    break; case 'VariableDeclaration':
      if (node.kind !== 'let') {
        fail("Only `let` declarations are allowed.")
      }
      if (node.declarations.length > 1) {
        fail("Only one assignment per `let` is allowed.")
      }

      var decl = node.declarations[0]
      if (decl.id.type !== 'Identifier') {
        fail("Destructuring not yet supported")
      }

      if (decl.init.type === 'ArrowFunctionExpression') {
        decl.init._name = decl.id.name
      }

      var typing = inferExpr(env, decl.init)
      return env.assign( decl.id.name, typing)

    break; case 'ExpressionStatement':
      return inferExpr(env, node.expression)

    default:
      throw new Error("Statement not supported: " + node.type)
  }
}



function inferExpr (env, node) {

  switch(node.type) {

    //
    // Constraint-generating nodes
    //
    case 'ReturnStatement':
      // Record expression for later use by function type generator
      // scope.returnExprs.push(node.argument)

      return inferExpr(ctx, node.argument)


    break; case 'Literal':
      log("> Literal", node.value)
      return Typing(null, litTermFromNode(node))


    break; case 'Identifier':
      log("> Identifier", node.name)

      // [PolyVar], p.33
      return env.lookup(node.name).instantiate()


    break; case 'ArrayExpression':
      log(`> ArrayExpression (${node.elements.length})`)

      //
      // Ensure all array elements agree on a single type
      //
      var elemType     = t.TypeVar(null)
      var elemTypings  = node.elements.map( e => inferExpr(env, e) )
      var elemMonoEnvs = elemTypings.map( et => et.monoEnv )

      var substitutions = unifyMonoEnvs(
        (err) =>
          new Errors.ArrayLiteralTypeError(err, env, node, elemTypings),
        env,
        elemMonoEnvs,
        elemTypings.map(
          et => t.Constraint(elemType, et.type)
        )
      )

      var subAll = subAllWith(substitutions)

      var arrayMonoEnv = extend(
        elemMonoEnvs.map( mEnv => objMap(mEnv, subAll) )
      )

      return Typing(arrayMonoEnv, t.TermArray(node, subAll(elemType)))



    break; case 'BinaryExpression':
      log("> BinaryExpression", node.operator)

      //
      // TODO: Handle binary operators other than +
      //

      var leftTyping = inferExpr(env, node.left)
      var rightTyping = inferExpr(env, node.right)

      var substitutions = unifyMonoEnvs(
        identity,
        env,
        [ leftTyping.monoEnv, rightTyping.monoEnv ],
        [
          t.Constraint( leftTyping.type, t.TermNum(node.left) ),
          t.Constraint( rightTyping.type, t.TermNum(node.right) )
        ]
      )

      // Δ = 𝚿Δ_1 ∪ 𝚿Δ_2
      var subAll = subAllWith(substitutions)

      var constraints = extend(
        objMap( leftTyping.monoEnv, subAll ),
        objMap( rightTyping.monoEnv, subAll )
      )

      return Typing(constraints, t.TermNum(node))

    break; case 'ArrowFunctionExpression':
      //
      // [Def], p.37
      //
    // TODO: Use [Def] only if node._name exists.
    //       Otherwise, use [Abs] and [Abs']
      log("> ArrowFunctionExpression")

      // Create new environment (scope) before descending into function body
      var functionEnv = Env(env)

      //
      // Δ_1 |- P_1 :: 𝞣_1
      // ...
      // Δ_n |- P_n :: 𝞣_n
      //
      // Assign a type variable to each parameter,
      // and also add to function environment.
      //
      var paramTypings = node.params.map(function(p) {
        if (p.type !== 'Identifier') fail("Destructuring not yet supported")

        let typeVar = t.TypeVar(p)
        let typing = Typing({ [p.name]: typeVar }, typeVar)
        functionEnv.assign( p.name, typing )

        return typing
      })

      //
      // Γ, Δ' ⊢ E :: 𝞣_0
      // TODO: block bodies with `return` statements
      // buildEnv(functionEnv, node.body)
      //
      var bodyTyping = inferExpr(functionEnv, node.body)

      //
      // Δ_0 = { f :: 𝞣_1 -> ... -> 𝞣_n -> 𝞣_0 }
      //
      // Build mono environment with only function as a constraint.
      //
      var paramTypes = paramTypings.map( pt => pt.type )
      var functionType = t.TermArrow( node, paramTypes, bodyTyping.type )
      var functionMonoEnv = { [node._name]: functionType }

      //
      // 𝚿 = 𝓤({ Δ_0, Δ_1, ..., Δ_n, Δ' })
      //
      // Ensure types of params and function body all agree.
      //
      var substitutions = unifyMonoEnvs(
        identity,
        functionEnv,
        paramTypings.map( pt => pt.monoEnv ).concat([ bodyTyping.monoEnv ])
      )

      //
      // Δ = 𝚿Δ_0 ∪ 𝚿Δ' \ U[ i=1..n; dom( Δ_i ) ]
      //
      // Apply all substitutions to get the final inferred
      // function mono environment.
      //
      var subAll = subAllWith(substitutions)

      // 𝚿Δ_0 ∪ 𝚿Δ'
      var allConstraints = extend(
        objMap( functionMonoEnv, subAll ),
        objMap( bodyTyping.monoEnv, subAll )
      )

      // \ U[ i=1..n; dom( Δ_i ) ]
      // Each param typing type should be a type variable.
      // TODO: Handle destructuring
      var paramNames = node.params.map( p => p.name )
      var constraints = objFilter(
        allConstraints,
        (c, varName) => paramNames.indexOf(varName) === -1
      )

      // For final type, pull out of substitution-applied constraints.
      return Typing( constraints, constraints[node._name] )

    break; case 'CallExpression':
      //
      // [App], p.34
      //
      log("> CallExpression")

      //
      // Γ; Δ_1 ⊢ E :: 𝞣'
      //
      var calleeTyping = inferExpr(env, node.callee)

      //
      // Γ; Δ_2 ⊢ F :: 𝞣''
      //
      var argumentTypings = node.arguments.map( a => inferExpr(env, a) )


      // α new
      var callExprType = t.TypeVar(node)

      //
      // 𝚿 = 𝓤({ Δ_1, Δ_2 }, { 𝞣' ~ 𝞣'' -> α })
      //
      var substitutions = unifyMonoEnvs(
        (err) =>
          new Errors.CallTypeError(err, env, node, calleeTyping, argumentTypings),
        env,
        [calleeTyping.monoEnv, argumentTypings.monoEnv],
        [t.Constraint(
          calleeTyping.type,
          t.TermArrow(
            node,
            argumentTypings.map( at => at.type ),
            callExprType
          )
        )]
      )

      //
      // Δ = 𝚿Δ_1 ∪ 𝚿Δ_2 ∪ ... ∪ 𝚿Δ_n
      //     where n = node.arguments.length+1
      //
      // The [App] rule in the paper only handles functions with one argument.
      // In our case, we need to handle any number of arguments.
      //
      var subAll = subAllWith(substitutions)

      var callMonoEnv = argumentTypings.reduce(
        (monoEnv, typing) => Object.assign(monoEnv, objMap( typing.monoEnv, subAll )),
        objMap( calleeTyping.monoEnv, subAll )
      )

      // 𝞣 = 𝚿α
      var finalType = subAll(callExprType)

      return Typing( callMonoEnv, finalType )

    default:
      throw new Error("Expression not supported: " + node.type)
  }

}

//
// [5.4] Unification of typings (p.32)
//
function unifyMonoEnvs (typeErrorHandler, env, monoEnvs, existingConstraints) {
  log("-=-=-\n[unifyMono]\n", monoEnvs)
  var varTypeMap = {}

  // Gather all variable usage, grouped by variable name
  monoEnvs.forEach(function(mEnv) {
    for (var varName in mEnv) {
      varTypeMap[varName] || (varTypeMap[varName] = [])
      varTypeMap[varName].push( mEnv[varName] )
    }
  })

  //
  // For each array of variable usages,
  // create a fresh type variable for all to agree on.
  //
  var constraints = flattenOneLevel(
    Object.keys(varTypeMap).map(function(varName) {
      var usages = varTypeMap[varName]
      var freshTypeVar = t.TypeVar(null)
      return usages.map( u => t.Constraint( freshTypeVar, u ) )
    })
  )

  try {
    return unify( env, constraints.concat(existingConstraints || []) )
  }
  catch (err) {
    if (err instanceof Errors.TypeError) throw typeErrorHandler(err)
    else                                 throw err
  }
}

function unify (env, constraints) {
  if (constraints.length === 0) return []

  var cs = constraints.shift()
  var left = cs.left
  var right = cs.right
  if (right.tag === 'TypeVar' && left.tag !== 'TypeVar') {
    // To simplify the algorithm,
    // always ensure a present type variable is on the left side.
    var csSwapped = { left: cs.right, right: cs.left }
    cs = csSwapped
    left = csSwapped.left
    right = csSwapped.right
    log("[[[[Swapped]]]]")
  }

  log("\n\n----\nUnifying", inspect(left), "\nAnd\n", inspect(right))
  log("====Constraints====\n", inspect(constraints))

  switch (left.tag) {

    case 'TypeVar':
      return [ t.Substitution(cs.left, cs.right) ].concat(
        unify( env, substituteConstraints(cs, constraints) )
      )

    case 'TermArrow':

      if (right.tag === 'TermArrow') {
        var newConstraints = [
          t.Constraint(left.range, right.range)
        ].concat(
          zip(left.domain, right.domain).map( terms => t.Constraint.apply(null, terms) )
        )
        log("=> Pushing new constraints from Arrow:", inspect(newConstraints))
        pushAll(constraints, newConstraints)
        return unify(env, constraints)
      }

    case 'TermNum':
    case 'TermBool':
    case 'TermString':
    case 'TermUndefined':
      if (right.tag === left.tag) {
        log("Unified " + left.tag)
        return unify(env, constraints)
      }

    default:
      throw new Errors.TypeError(env, left, right)
  }

}

// Exported for testing
exports.substituteConstraints = substituteConstraints

function substituteConstraints (sub, constraints) {
  // TODO: occurs check
  log(`${sub.left.tag} ${sub.left._id || ''} = ${sub.right.tag} ${sub.right._id || ''}`)

  return constraints.map(function (c) {
    log("  [sub] checking against", c.left.tag, c.left._id || '', "=", c.right.tag, c.right._id || '')

    if (t.eq(c.left, sub.left)) {
      log("! [sub] Replacing", c.left, "with", sub.right)
      return t.Constraint(sub.right, c.right)
    }
    else if (t.eq(c.right, sub.left)) {
      log("!.[sub] Replacing", c.right, "with", sub.right)
      return t.Constraint(c.left, sub.right)
    }
    else if (c.right.tag === 'TermArrow') {
      c.right.domain = c.right.domain.map(function(term) {
        log("  [sub][arrow] checking against", term.tag, term._id)
        if (t.eq(term, sub.left)) {
          log("! [sub][arrow] Replacing", term, "with", sub.right)
          return sub.right
        }
        else return term
      })
      var range = c.right.range
      log("  [sub][arrow] checking range against", range.tag, range._id)
      if (t.eq(range, sub.left)) {
        log("! [sub][arrow] Replacing range", range, "with", sub.right)
        c.right.range = sub.right
      }
      return c
    }
    else {
      // No substitutions to make.
      return c
    }
  })
}

function litTermFromNode (node) {
  switch (typeof node.value) {
    case 'number': return t.TermNum(node)
    case 'string': return t.TermString(node)
  }
  fail("No such type from literal: " + node.value)
}

function zip (a, b) {
  var results = []
  for (var i=0; i < a.length; i++) {
    results.push([a[i], b[i]])
  }
  return results
}

function subAllWith (substitutions) {
  return (type) => substitutions.reduce( (ty, sub) => t.substitute(sub, ty), type )
}

var log = function () {
  if (! process.env.DEBUG_TYPES) return
  console.log.apply(console, [].slice.call(arguments))
}