FUNCTION Calc( nBase )
   LOCAL nTotal := 0
   nTotal := nBase + 1
   nTotal += 2
   nTotal++
   IF nTotal = 3
      ? nTotal
   ENDIF
   RETURN nTotal
