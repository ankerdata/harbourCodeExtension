/*
 * Hand-written C extension implementing a Harbour function.
 * No Harbour-codegen markers anywhere in this file — the indexer
 * MUST keep this in the workspace symbol set so that go-to-def for
 * MyCFunc() lands here when no .prg defines MyCFunc.
 */

#include "hbapi.h"
#include "hbapierr.h"

HB_FUNC( MYCFUNC )
{
   const char * pszArg = hb_parc( 1 );
   if( pszArg )
      hb_retc( pszArg );
   else
      hb_errRT_BASE_SubstR( EG_ARG, 3012, NULL, HB_ERR_FUNCNAME, 1, hb_paramError( 1 ) );
}

HB_FUNC( MYCHELPER )
{
   hb_retni( hb_parni( 1 ) + hb_parni( 2 ) );
}
