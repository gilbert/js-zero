var _         = require('lodash')
var t         = require('./definitions')
var transform = require('./transform')
var Record    = require('./records')

exports.eq = eq
exports.substitute   = substitute
exports.applySubs    = applySubs
exports.freshTypeVar = freshTypeVar

exports.transform = transform

// Re-export type constructors
Object.assign(module.exports, t)

function eq (a, b) {
  if (a.tag === 'TermNum'
   || a.tag === 'TermBool'
   || a.tag === 'TermString'
   || a.tag === 'TermUndefined'
  ) {
    return b.tag === a.tag
  }
  else if (a.tag === 'TypeVar') {
    if (b.tag !== 'TypeVar') return false

    if (a._id !== null && b._id !== null) return a._id === b._id
    else                                  return matchTypeVars(a, b)
  }
  else if (a.tag === 'RowTypeVar') {
    if (b.tag !== 'RowTypeVar') return false

    if (a._id !== null && b._id !== null) return a._id === b._id
    else                                  return matchTypeVars(a, b)
  }
  else if (a.tag === 'Con') {
    return b.tag === 'Con'
        && _.chain(a.args).zip(b.args).all( pair => eq(pair[0], pair[1]) ).value()
  }
  else if (a.tag === 'Arrow') {
    return b.tag === 'Arrow'
        && eq(a.range, b.range)
        && _.chain(a.domain).zip(b.domain).all( pair => eq(pair[0], pair[1]) ).value()
  }
  else if (a.tag === 'Record') {
    return b.tag === 'Record' && Record.isEq(eq, a, b)
  }
  else {
    throw Error(`Unrecognized type: ${ JSON.stringify(a) }`)
  }
}

// Matching is done when comparing a type annotation to an inferred type
function matchTypeVars (a, b) {
  if ( a._id === null && b._id === null ) {
    return a.name === b.name
  }
  else if ( a._id === null ) {
    a._id = b._id
    return true
  }
  else if ( b._id === null ) {
    b._id = a._id
    return true
  }
  else {
    return a._id === b._id
  }
}

function substitute (sub, type) {
  if ( ! type.tag ) throw new Error("[substitute] Target must be a type")
  return transform(substituteNodes, sub, type)
}

var substituteNodes = {
  'TypeVar': function (sub, type) {
    return eq(sub.left, type)
      ? Object.assign(sub.right, { source: type.source })
      : type
  },

  'Record': function (sub, type) {
    // Trade complexity for performance.
    // Records are common, so it should be worth it.
    var matchFound = false

    var newRows = type.rows.map(function(row) {
      if (row.tag === 'RowTypeVar') {
        if ( ! eq(sub.left, row) ) return row
        matchFound = true
        // Here we are dealing with a type of kind _record_;
        // type is either a RowTypeVar or Record.
        return sub.right.tag === 'Record'
          ? sub.right.rows
          : sub.right
      }
      else if (row.tag === 'RowSet') {
        var submatchFound = false

        var newLabelTypes = _.mapValues(row.labelTypes, function (ty) {
          if ( ! eq(sub.left, ty) ) return ty
          submatchFound = true
          // Here we are dealing with a standard kind of type; just replace it.
          return sub.right
        })

        if (submatchFound) {
          matchFound = true
          return t.RowSet(newLabelTypes)
        }
        else {
          return row
        }
      }
    })

    return matchFound
      ? t.Record( type.source, Record.optimizeRows(_.flatten(newRows)) )
      : type
  }
}


function applySubs (substitutions, type) {
  if ( ! type.tag ) throw new Error("[substitute] Target must be a type")
  return substitutions.reduce( (ty, sub, i) => substitute(sub, ty), type )
}


function freshTypeVar (cache, type) {
  return transform(freshTypeVarNodes, cache, type)
}

var freshTypeVarNodes = {

  'TypeVar': function (cache, type) {
    if ( ! cache[type._id] ) {
      cache[type._id] = t.TypeVar(type.source)
    }
    return cache[type._id]
  },

  'RowTypeVar': function (cache, type) {
    if ( ! cache[type._id] ) {
      cache[type._id] = t.RowTypeVar(type.source)
    }
    return cache[type._id]
  }
}
