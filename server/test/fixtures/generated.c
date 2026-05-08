/*
 * Harbour 3.2.0dev (r2602080306)
 * Microsoft Visual C 19.50.35728 (32-bit)
 * Generated C source from "sharedx\seterror.prg"
 */

#include "hbvmpub.h"
#include "hbinit.h"


HB_FUNC( SETERROR );


HB_INIT_SYMBOLS_BEGIN( hb_vm_SymbolInit_SETERROR )
{ "SETERROR", {HB_FS_PUBLIC | HB_FS_LOCAL}, {HB_FUNCNAME( SETERROR )}, NULL },
{ "QQOUT",    {HB_FS_PUBLIC},               {NULL},                    NULL }
HB_INIT_SYMBOLS_END( hb_vm_SymbolInit_SETERROR )

#if defined( HB_PRAGMA_STARTUP )
   #pragma startup hb_vm_SymbolInit_SETERROR
#elif defined( HB_DATASEG_STARTUP )
   #define HB_DATASEG_BODY    HB_DATASEG_FUNC( hb_vm_SymbolInit_SETERROR )
   #include "hbiniseg.h"
#endif

HB_FUNC( SETERROR )
{
   static const HB_BYTE pcode[] = {
      120, 0, 0, 0, 0, 109, 0, 0, 0, 0, 7
   };

   hb_vmExecute( pcode, symbols );
}
