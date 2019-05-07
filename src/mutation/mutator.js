/**
 * @module mutation/mutator
 */


// Constants
const NOT_IMPLEMENTED = 'NOT IMPLEMENTED';


/**
 * Interface for applying and undoing environment mutations.
 *
 * @property {String} name Mutator name.
 */
class Mutator {

    /**
     * Construct a named mutator.
     *
     * @param {String} name Mutator name.
     */
    constructor(name) {
        this.name = name;
    }

    /**
     * Apply mutation to a source object.
     *
     * @param   {Object}                  source Source object to mutate.
     * @returns {Promise<MutationResult>}        Result of applying mutation. May be null if mutation could not be applied.
     */
    async apply(source) { throw new Error(NOT_IMPLEMENTED); }

    /**
     * Undo a mutation.
     *
     * @param   {Object}          mutant   Mutated object.
     * @param   {Object}          mutation Mutation that was applied to generate the mutant.
     * @returns {Promise<Object>}
     */
    async undo(mutant, mutation) { throw new Error(NOT_IMPLEMENTED); }

}

// Export
module.exports = Mutator;
