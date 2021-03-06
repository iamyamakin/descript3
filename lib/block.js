const no = require( 'nommon' );

const { create_error, ERROR_ID } = require( './error' );

const DepsDomain = require( './deps_domain' );

//  const extend_option = require( './extend_option' );

//  ---------------------------------------------------------------------------------------------------------------  //

class Block {

    constructor( block, options ) {
        const f = function( { block, options } = {} ) {
            return new f.constructor(
                f._extend_block( block ),
                f._extend_options( options )
            );
        };

        f.__proto__ = this.__proto__;
        f._init_block( block );
        f._init_options( options );

        return f;
    }

    _init_block( block ) {
        this._block = block;
    }

    _init_options( options ) {
        this._options = extend_options( {}, options );
    }

    _extend_block( block ) {
        return this._block;
    }

    _extend_options( options ) {
        return extend_options( this._options, options );
    }

    async _run( { run_context, block_cancel, deps_domain, cancel, params, context, prev, n_parents } ) {
        let h_timeout = null;

        function clear_timeout() {
            if ( h_timeout ) {
                clearTimeout( h_timeout );
                h_timeout = null;
            }
        }

        run_context.n_blocks++;

        let error;
        let result;
        let deps;
        let active;

        try {
            deps = await this._do_options_deps( run_context, block_cancel, deps_domain, n_parents );

            active = true;

            run_context.n_active_blocks++;

            if ( prev !== undefined ) {
                deps.prev = prev;
            }

            if ( this._options.timeout > 0 ) {
                h_timeout = setTimeout( () => {
                    block_cancel.cancel( {
                        id: ERROR_ID.BLOCK_TIMED_OUT,
                    } );
                    h_timeout = null;
                }, this._options.timeout );
            }

            const lifecycle = this._options.lifecycle;
            if ( !lifecycle || !lifecycle.length ) {
                //  В блоке нет ничего из options.params, options.before, options.after, options.error.
                //  Просто вызываем экшен.
                //
                result = await this._do_action( run_context, block_cancel, deps_domain, cancel, params, context, deps, n_parents );

            } else {
                result = await this._do_lifecycle_step( 0, run_context, block_cancel, deps_domain, cancel, params, context, deps, n_parents );
            }

        } catch ( e ) {
            error = create_error( e );
        }

        clear_timeout();

        block_cancel.close();

        if ( active ) {
            run_context.n_active_blocks--;
        }
        run_context.n_blocks--;
        run_context.queue_deps_check();

        if ( this._options.id ) {
            if ( error ) {
                run_context.reject_promise( this._options.id, error );

            } else {
                run_context.resolve_promise( this._options.id, result );
            }
        }

        if ( error ) {
            throw error;
        }

        return result;
    }

    async _do_options_deps( run_context, block_cancel, deps_domain, n_parents ) {
        const deps = this._options.deps;
        if ( !deps || !deps.length ) {
            return {};
        }

        if ( !deps_domain ) {
            throw create_error( {
                id: ERROR_ID.INVALID_DEPS_ID,
            } );
        }

        const promises = deps.map( ( id ) => {
            if ( !deps_domain.is_valid_id( id ) ) {
                throw create_error( {
                    id: ERROR_ID.INVALID_DEPS_ID,
                } );
            }

            return run_context.get_promise( id );
        } );

        run_context.waiting_for_deps.push( {
            block_cancel: block_cancel,
            n_parents: n_parents,
        } );

        try {
            const results = await Promise.race( [
                block_cancel.get_promise(),
                Promise.all( promises ),
            ] );

            const r = {};

            deps.forEach( ( id, i ) => {
                r[ id ] = results[ i ];
            } );

            return r;

        } catch ( error ) {
            //  FIXME: А зачем вот это тут?
            const error_id = no.jpath( '.error.id', error );
            if ( error_id === ERROR_ID.DEPS_NOT_RESOLVED ) {
                throw error;
            }

            throw create_error( {
                id: ERROR_ID.DEPS_ERROR,
                reason: error,
            } );

        } finally {
            run_context.waiting_for_deps = run_context.waiting_for_deps.filter( ( item ) => item.block_cancel !== block_cancel );
        }
    }

    async _do_lifecycle_step( index, run_context, block_cancel, deps_domain, cancel, params, context, deps, n_parents ) {
        const lifecycle = this._options.lifecycle;
        const step = lifecycle[ index ];

        try {
            let result;

            if ( step.params ) {
                if ( typeof step.params !== 'function' ) {
                    throw create_error( {
                        id: ERROR_ID.INVALID_OPTIONS_PARAMS,
                        message: 'options.params must be a function',
                    } );
                }

                //  Тут не нужен cancel.
                params = step.params( { params, context, deps } );
                if ( !( params && typeof params === 'object' ) ) {
                    throw create_error( {
                        id: ERROR_ID.INVALID_OPTIONS_PARAMS,
                        message: 'Result of options.params must be an object',
                    } );
                }
            }

            if ( typeof step.before === 'function' ) {
                result = await step.before( { cancel, params, context, deps } );
                block_cancel.throw_if_cancelled();

                if ( result instanceof Block ) {
                    result = await run_context.run( {
                        block: result,
                        block_cancel: block_cancel.create(),
                        deps_domain: new DepsDomain( deps_domain ),
                        params: params,
                        context: context,
                        cancel: cancel,
                        n_parents: n_parents + 1,
                    } );
                }
                block_cancel.throw_if_cancelled();
            }

            if ( result === undefined ) {
                if ( index < lifecycle.length - 1 ) {
                    result = await this._do_lifecycle_step( index + 1, run_context, block_cancel, deps_domain, cancel, params, context, deps, n_parents );

                } else {
                    result = await this._do_action( run_context, block_cancel, deps_domain, cancel, params, context, deps, n_parents );
                }
            }
            block_cancel.throw_if_cancelled();

            if ( typeof step.after === 'function' ) {
                result = await step.after( { cancel, params, context, deps, result } );
                block_cancel.throw_if_cancelled();

                if ( result instanceof Block ) {
                    result = await run_context.run( {
                        block: result,
                        block_cancel: block_cancel.create(),
                        deps_domain: new DepsDomain( deps_domain ),
                        params: params,
                        context: context,
                        cancel: cancel,
                        n_parents: n_parents + 1,
                    } );
                }
                block_cancel.throw_if_cancelled();
            }

            return result;

        } catch ( e ) {
            const error = create_error( e );

            //  FIXME: А нужно ли уметь options.error делать асинхронным?
            //
            if ( typeof step.error === 'function' ) {
                return step.error( { cancel, params, context, deps, error } );
            }

            throw error;
        }
    }

    async _do_action( run_context, block_cancel, deps_domain, cancel, params, context, deps, n_parents ) {
        let result;

        const cache = this._options.cache;
        let key;
        const options_key = this._options.key;
        if ( cache && options_key ) {
            //  Тут не нужен cancel.
            key = ( typeof options_key === 'function' ) ? options_key( { params, context, deps } ) : options_key;
            if ( typeof key !== 'string' ) {
                key = null;
            }
            if ( key ) {
                try {
                    result = await cache.get( { key, context } );

                } catch ( e ) {
                    //  Do nothing.
                }
                block_cancel.throw_if_cancelled();

                if ( result !== undefined ) {
                    return result;
                }
            }
        }

        result = await this._action( { run_context, block_cancel, deps_domain, cancel, params, context, deps, n_parents } );
        block_cancel.throw_if_cancelled();

        if ( result !== undefined && key ) {
            try {
                const promise = cache.set( {
                    key: key,
                    value: result,
                    maxage: this._options.maxage,
                    context: context,
                } );
                //  FIXME: А как правильно? cache.set может вернуть промис, а может и нет,
                //  при этом промис может зафейлиться. Вот так плохо:
                //
                //      await cache.set( ... )
                //
                //  так как ждать ответа мы не хотим. Но результат хотим проигнорить.
                //
                if ( promise && typeof promise.catch === 'function' ) {
                    //  It's catchable!
                    promise.catch( () => {
                        //  Do nothing.
                    } );
                }

            } catch ( e ) {
                //  Do nothing.
            }
        }

        return result;
    }

}

Block.prototype = Object.create( Function.prototype );

module.exports = Block;

//  ---------------------------------------------------------------------------------------------------------------  //

function extend_options( what, by = {} ) {
    const options = {};

    options.name = by.name || what.name;

    options.id = by.id;
    options.deps = extend_deps( by.deps );

    options.lifecycle = extend_lifecycle( what, by );

    options.timeout = by.timeout || what.timeout;

    options.key = by.key || what.key;
    options.maxage = by.maxage || what.maxage;
    options.cache = by.cache || what.cache;

    options.required = by.required;

    options.logger = by.logger || what.logger;

    return options;
}

function extend_deps( deps ) {
    if ( !deps ) {
        return null;
    }

    if ( !Array.isArray( deps ) ) {
        deps = [ deps ];
    }

    return ( deps.length ) ? deps : null;
}

function extend_lifecycle( what, by ) {
    if ( by.lifecycle ) {
        return ( what.lifecycle ) ? [].concat( by.lifecycle, what.lifecycle ) : [].concat( by.lifecycle );

    } else if ( by.params || by.before || by.after || by.error ) {
        const lifecycle = [
            {
                params: by.params,
                before: by.before,
                after: by.after,
                error: by.error,
            },
        ];

        return ( what.lifecycle ) ? lifecycle.concat( what.lifecycle ) : lifecycle;

    } else {
        return ( what.lifecycle ) ? [].concat( what.lifecycle ) : undefined;
    }
}

/*
function eval_params_item( item, params, context, deps ) {
    const r = {};

    const callback_args = { params, context, deps };

    for ( const p_name in item ) {
        const p_value = item[ p_name ];

        let value;
        if ( typeof p_value === 'function' ) {
            value = p_value( callback_args );

        } else if ( p_value === null ) {
            value = params[ p_name ];

        } else if ( p_value !== undefined ) {
            value = params[ p_name ];
            if ( value === undefined ) {
                value = p_value;
            }
        }

        if ( value !== undefined ) {
            r[ p_name ] = value;
        }
    }

    return r;
}
*/

