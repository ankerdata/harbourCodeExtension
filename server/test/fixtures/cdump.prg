PROCEDURE Boot()
   ? CFunc()
RETURN

#pragma BEGINDUMP
#include <hbapi.h>

HB_FUNC( CFUNC )
{
   hb_retc("from C");
}

void helper()
{
   if (1) { /* nested */ }
}
#pragma ENDDUMP
