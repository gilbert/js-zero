{
  var t = require('../types')
  var ANNOTATION = t.ANNOTATION

  var pretty = require('../pretty')
  var typeVarsByName = {}
  var rowTypeVarsByName = {}

  function getLast (arr) { return arr[arr.length-1] }
}

Start
  = __ type:DomainType __ { return type }

DomainType
  = Constructor
  / Term
  / TypeVar
  / Arrow
  / DomainRecord

RangeType
  = Constructor
  / Term
  / TypeVar
  / Arrow
  / RangeRecord

Term
  = name:ProperIdentifier {
    var type = t['Term' + name]
    if ( ! type ) {
      if ( t['Con' + name] )
        throw new Error(`Type Constructor ${name} takes exactly #{type.length-1} type arguments.`)
      else
        throw new Error('Type does not exist: ' + name)
    }
    return type(ANNOTATION)
  }
  / "(" ")" {
    return t.TermUndefined(ANNOTATION)
  }

TypeVar
  = name:Identifier {
    var typeVar = typeVarsByName[name]
    if ( ! typeVar ) {
      typeVar = typeVarsByName[name] = t.TypeVar(ANNOTATION)
      typeVar.name = name
    }
    if ( typeVar.tag !== 'TypeVar' ) {
      // TODO: Better error message
      throw new Error("Cannot use row type variable in place of type variable: " + name)
    }
    return typeVar
  }

Constructor
  = constructor:ProperIdentifier __ "(" __ first:DomainType __ rest:("," __ DomainType)* __ ")" {
    var typeParams = [first].concat(rest)

    var type = t['Con' + constructor]
    if ( ! type ) {
      throw new Error(`Type Constructor does not exist: ${constructor}`)
    }
    if ( type.length-1 === 0 && typeParams.length > 0 ) {
      throw new Error(`Type Constructor ${constructor} does not take any type arguments.`)
    }
    else if ( type.length-1 !== typeParams.length ) {
      throw new Error(`Type Constructor ${constructor} takes exactly ${ pretty.pluralize('type argument', type.length-1)}.`)
    }
    return type( ANNOTATION, ...typeParams )
  }

Arrow
  = "(" __ first:DomainType rest:(__ "," __ DomainType)* ")" __ "=>" __ range:RangeType {
    var domain = [first].concat( rest.map(getLast) )
    return t.Arrow(ANNOTATION, domain, range)
  }

EmptyRecord
  = "{" __ "}" {
    return t.Record(ANNOTATION, [])
  }

SingularRecord
  = "{" __ row:(RowTypeVariable / RecordVar) __ "}" {
    return t.Record(ANNOTATION, [row])
  }

DomainRecord
  = EmptyRecord
  / SingularRecord
  / "{" __ rowSet:RowSet __ rowVar:("," __ RecordVar)? __  "}" {
    var rows = [ rowSet, rowVar && getLast(rowVar) ].filter(_ => _)
    return t.Record(ANNOTATION, rows)
  }
RangeRecord
  = EmptyRecord
  / SingularRecord
  / "{" __ first:RangeRecordPart rest:(__ "," __ RangeRecordPart)* __ "}" {
    var rows = [first].concat( rest.map(getLast) )
    return t.Record(ANNOTATION, rows)
  }

RangeRecordPart
  = RecordVar
  / RowSet

RecordVar
  = "..." __ polyVar:RowTypeVariable { return polyVar }

RowTypeVariable
  = name:Identifier {
    var rowTypeVar = rowTypeVarsByName[name]
    if ( ! rowTypeVar ) {
      rowTypeVar = rowTypeVarsByName[name] = t.RowTypeVar(ANNOTATION)
      rowTypeVar.name = name
    }
    if ( rowTypeVar.tag !== 'RowTypeVar' ) {
      // TODO: Better error message
      throw new Error("Cannot use type variable in place of row type variable: " + name)
    }
    return rowTypeVar
  }

RowSet
  = first:LabelAndType __ pairs:(__ "," __ LabelAndType)* __ {
    var labels = { [first[0]]: first[1] }

    for (var i=0; i < pairs.length; i++) {
      var pair = getLast(pairs[i])
      if ( labels[ pair[0] ] ) {
        throw new Error("Annotation: Duplicate property in object: " + pair[0])
      }
      labels[ pair[0] ] = pair[1]
    }
    return t.RowSet(labels)
  }

LabelAndType
  = label:(Identifier / ProperIdentifier) __ ":" __ type:DomainType {
    return [label, type]
  }

RecordPolyVar
  = "..." __ polyVar:Identifier { return polyVar }

Identifier "Identifier"
  = first:[a-z_] rest:IdentifierPart* { return first + rest.join('') }
ProperIdentifier "Type"
  = first:[A-Z] rest:IdentifierPart* { return first + rest.join('') }
IdentifierPart
  = [a-zA-Z0-9_]

__
  = (WhiteSpace / LineTerminatorSequence / Comment)* { return; }

WhiteSpace "WhiteSpace"
  = "\t"
  / "\v"
  / "\f"
  / " "
  / "\u00A0"
  / "\uFEFF"
  / Zs

LineTerminatorSequence "end of line"
  = "\n"
  / "\r\n"
  / "\r"
  / "\u2028"
  / "\u2029"

Comment "comment"
  = "//" (!LineTerminator SourceCharacter)*

Zs = [\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]

LineTerminator = [\n\r\u2028\u2029]

SourceCharacter = .

